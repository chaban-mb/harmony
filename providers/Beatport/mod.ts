import type { Artist, BeatportRelease, PaginatedResult, Release, Track } from './api_types.ts';
import type { ArtistCreditName, EntityId, HarmonyRelease, HarmonyTrack, LinkType } from '@/harmonizer/types.ts';
import { variousArtists } from '@/musicbrainz/special_entities.ts';
import {
	type ApiAccessToken,
	type ApiQueryOptions,
	type CacheEntry,
	MetadataApiProvider,
	type ProviderOptions,
	ReleaseApiLookup,
} from '@/providers/base.ts';
import type { ProviderCategory } from '@/providers/categories.ts';
import { DurationPrecision, FeatureQuality, FeatureQualityMap } from '@/providers/features.ts';
import { getFromEnv } from '@/utils/config.ts';
import { parseHyphenatedDate, PartialDate } from '@/utils/date.ts';
import { ProviderError, ResponseError } from '@/utils/errors.ts';
import { ResponseError as SnapResponseError } from 'snap-storage';
import { decodeBase64Url } from 'std/encoding/base64url.ts';

// Beatport API authentication options (configured via environment variables):
// - Method 1 (Credentials): HARMONY_BEATPORT_CLIENT_ID + USERNAME + PASSWORD
// - Method 2 (Refresh token): HARMONY_BEATPORT_CLIENT_ID + REFRESH_TOKEN
// - Method 3 (Static token): HARMONY_BEATPORT_API_TOKEN
const beatportClientId = getFromEnv('HARMONY_BEATPORT_CLIENT_ID') || '';
const beatportApiToken = getFromEnv('HARMONY_BEATPORT_API_TOKEN') || '';
const beatportRefreshToken = getFromEnv('HARMONY_BEATPORT_REFRESH_TOKEN') || '';
const beatportUsername = getFromEnv('HARMONY_BEATPORT_USERNAME') || '';
const beatportPassword = getFromEnv('HARMONY_BEATPORT_PASSWORD') || '';

export class BeatportResponseError extends ResponseError {
	constructor(message: string, url: URL) {
		super('Beatport', message, url);
	}
}

interface BeatportQueryOptions extends ApiQueryOptions {
	isRetry?: boolean;
}

export default class BeatportProvider extends MetadataApiProvider {
	constructor(options: ProviderOptions = {}) {
		super(options);

		if (options.appInfo) {
			const { name, version, contact } = options.appInfo;
			this.userAgent = `${name}/${version}`;
			if (contact) {
				this.userAgent += ` +${contact}`;
			}
		} else {
			this.userAgent = 'Harmony';
		}
	}

	readonly name = 'Beatport';

	readonly supportedUrls = new URLPattern({
		hostname: 'www.beatport.com',
		pathname: '/:language(\\w{2})?/:type(artist|label|release|track)/:slug/:id(\\d+)',
	});

	override readonly categories = new Set<ProviderCategory>(['digital']);

	override readonly features: FeatureQualityMap = {
		'cover size': 1400,
		'duration precision': DurationPrecision.MS,
		'GTIN lookup': FeatureQuality.GOOD,
		'MBID resolving': FeatureQuality.PRESENT,
		'release label': FeatureQuality.GOOD,
	};

	readonly entityTypeMap = {
		artist: 'artist',
		label: 'label',
		release: 'release',
		recording: 'track',
	};

	readonly releaseLookup = BeatportReleaseLookup;

	override readonly launchDate: PartialDate = {
		year: 2005,
		month: 1,
		day: 7,
	};

	readonly apiBaseUrl = 'https://api.beatport.com/v4/';
	readonly baseUrl = 'https://www.beatport.com';

	constructUrl(entity: EntityId): URL {
		return new URL([entity.type, entity.slug ?? '-', entity.id].join('/'), this.baseUrl);
	}

	override getLinkTypesForEntity(): LinkType[] {
		/** See comment at {@linkcode BeatportReleaseLookup.convertRawRelease}. */
		return ['paid download'];
	}

	async query<Data>(apiUrl: URL, options: BeatportQueryOptions = {}): Promise<CacheEntry<Data>> {
		try {
			await this.requestDelay;
			const accessToken = await this.cachedAccessToken(this.requestAccessToken.bind(this));
			return await this.fetchJSON<Data>(apiUrl, {
				policy: { maxTimestamp: options.snapshotMaxTimestamp },
				requestInit: {
					headers: {
						'Authorization': `Bearer ${accessToken}`,
						'Accept': 'application/json',
						'User-Agent': this.userAgent,
					},
				},
			});
		} catch (error) {
			if (error instanceof SnapResponseError) {
				const { response } = error;
				if (response.status === 401 && !options.isRetry) {
					this.log.warn(`${this.name}: Access token rejected (HTTP 401), invalidating cache and retrying...`);
					localStorage.removeItem(`${this.name}:accessToken`);
					const accessToken = await this.cachedAccessToken(this.requestAccessToken.bind(this));
					return this.fetchJSON<Data>(apiUrl, {
						policy: { maxTimestamp: options.snapshotMaxTimestamp },
						requestInit: {
							headers: {
								'Authorization': `Bearer ${accessToken}`,
								'Accept': 'application/json',
								'User-Agent': this.userAgent,
							},
						},
					});
				}

				let apiError: { detail?: string; message?: string; error?: string } | undefined;
				try {
					apiError = await response.clone().json();
				} catch {
					// Ignore secondary JSON parsing error, rethrow original error.
				}
				const errorMessage = apiError?.detail || apiError?.message || apiError?.error;
				if (errorMessage) {
					throw new BeatportResponseError(`${errorMessage} (HTTP ${response.status})`, apiUrl);
				}
			}
			throw error;
		}
	}

	private async requestAccessToken(): Promise<ApiAccessToken> {
		// 1. Static API / Bearer token provided in environment
		if (beatportApiToken) {
			this.log.debug(`${this.name}: Using static API token from environment`);
			// Decode unverified JWT payload to extract `exp` for proactive local cache expiry.
			const parts = beatportApiToken.split('.');
			if (parts.length === 3) {
				try {
					const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
					if (payload.exp) {
						return {
							accessToken: beatportApiToken,
							validUntilTimestamp: payload.exp * 1000,
						};
					}
				} catch {
					// Fall through to default validity.
				}
			}
			return {
				accessToken: beatportApiToken,
				validUntilTimestamp: Date.now() + 3600 * 1000,
			};
		}

		// 2. OAuth refresh token provided in environment or cached in Deno's localStorage
		const refreshToken = beatportRefreshToken || localStorage.getItem(`${this.name}:refreshToken`);
		if (refreshToken) {
			if (!beatportClientId) {
				throw new ProviderError(
					this.name,
					'Beatport API requires HARMONY_BEATPORT_CLIENT_ID',
				);
			}
			this.log.info(`${this.name}: Refreshing access token via OAuth refresh token...`);
			const url = new URL('auth/o/token/', this.apiBaseUrl);
			const body = new URLSearchParams({
				grant_type: 'refresh_token',
				client_id: beatportClientId,
				refresh_token: refreshToken,
			});
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'Origin': 'https://api.beatport.com',
					'Referer': 'https://api.beatport.com/',
				},
				body,
			});
			try {
				const result = await response.json();
				if (result.access_token) {
					if (result.refresh_token) {
						localStorage.setItem(`${this.name}:refreshToken`, result.refresh_token);
					}
					this.log.info(
						`${this.name}: Access token refreshed successfully (valid for ${result.expires_in ?? 3600}s)`,
					);
					return {
						accessToken: result.access_token,
						validUntilTimestamp: Date.now() + ((result.expires_in ?? 3600) * 1000),
					};
				}
			} catch {
				// Refresh token may have expired or been revoked, fall through to credentials if available.
				this.log.warn(`${this.name}: Refresh token expired or revoked, falling back to credentials...`);
				localStorage.removeItem(`${this.name}:refreshToken`);
			}
		}

		// 3. Account credentials provided in environment (headless OAuth PKCE flow)
		// Beatport's public web client ID has no client secret, so standard Resource Owner Password
		// Credentials (`grant_type=password`) is rejected with 400 unauthorized_client. We therefore
		// execute the official web client's Authorization Code flow with PKCE headlessly.
		if (beatportUsername && beatportPassword) {
			if (!beatportClientId) {
				throw new ProviderError(
					this.name,
					'Beatport API requires HARMONY_BEATPORT_CLIENT_ID',
				);
			}
			this.log.info(`${this.name}: Authenticating as '${beatportUsername}' via headless OAuth PKCE login...`);
			try {
				const origin = 'https://api.beatport.com';
				// Exact redirect URI registered on Beatport's OAuth authorization server for this client ID.
				const redirectUri = 'https://api.beatport.com/v4/auth/o/post-message/';

				// Step 1: POST to /v4/auth/login/ to authenticate credentials and acquire session cookie
				const loginResponse = await fetch(new URL('auth/login/', this.apiBaseUrl), {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Origin': origin,
						'Referer': `${origin}/`,
					},
					body: JSON.stringify({ username: beatportUsername, password: beatportPassword }),
				});

				if (!loginResponse.ok) {
					const errorText = await loginResponse.text();
					let message = 'Incorrect username or password';
					try {
						const j = JSON.parse(errorText);
						message = (typeof j === 'string' ? j : j.detail) || message;
					} catch {
						// Fall back to default error message.
					}
					throw new Error(`Login rejected: ${message}`);
				}

				const setCookie = loginResponse.headers.get('set-cookie');
				const cookies: string[] = [];
				if (setCookie) {
					for (const part of setCookie.split(',')) {
						const cookiePair = part.split(';')[0].trim();
						if (cookiePair.startsWith('sessionid=') || cookiePair.startsWith('csrftoken=')) {
							cookies.push(cookiePair);
						}
					}
				}

				// Step 2: Generate PKCE verifier and challenge
				const randomBytes = crypto.getRandomValues(new Uint8Array(48));
				const verifier = btoa(String.fromCharCode(...randomBytes))
					.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
				const challengeHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
				const challenge = btoa(String.fromCharCode(...new Uint8Array(challengeHash)))
					.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

				// Step 3: GET /v4/auth/o/authorize/ to receive auth code using session cookie
				const authorizeUrl = new URL('auth/o/authorize/', this.apiBaseUrl);
				authorizeUrl.searchParams.set('response_type', 'code');
				authorizeUrl.searchParams.set('client_id', beatportClientId);
				authorizeUrl.searchParams.set('redirect_uri', redirectUri);
				authorizeUrl.searchParams.set('code_challenge', challenge);
				authorizeUrl.searchParams.set('code_challenge_method', 'S256');

				const authResponse = await fetch(authorizeUrl, {
					headers: {
						'Origin': origin,
						'Referer': `${origin}/`,
						'Cookie': cookies.join('; '),
					},
					redirect: 'manual',
				});

				const location = authResponse.headers.get('location');
				const code = ((location || '').match(/[?&#]code=([^&]+)/) || [])[1];
				if (!code) {
					throw new Error('No authorization code returned from Beatport authorize endpoint');
				}

				// Step 4: Exchange code for token
				const tokenUrl = new URL('auth/o/token/', this.apiBaseUrl);
				const body = new URLSearchParams({
					grant_type: 'authorization_code',
					code,
					redirect_uri: redirectUri,
					client_id: beatportClientId,
					code_verifier: verifier,
				});

				const tokenResponse = await fetch(tokenUrl, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
						'Origin': origin,
						'Referer': `${origin}/`,
					},
					body,
				});

				const result = await tokenResponse.json();
				if (result.access_token) {
					if (result.refresh_token) {
						localStorage.setItem(`${this.name}:refreshToken`, result.refresh_token);
					}
					this.log.info(
						`${this.name}: Authentication successful (token valid for ${result.expires_in ?? 36000}s)`,
					);
					return {
						accessToken: result.access_token,
						validUntilTimestamp: Date.now() + ((result.expires_in ?? 36000) * 1000),
					};
				}
				throw new Error(result.error_description ?? result.error ?? 'Missing access token');
			} catch (error) {
				throw new ProviderError(this.name, 'Failed to obtain access token via PKCE login flow', {
					cause: error,
				});
			}
		}

		throw new ProviderError(
			this.name,
			'Beatport API requires credentials. Please configure Method 1 (HARMONY_BEATPORT_CLIENT_ID, USERNAME, PASSWORD), Method 2 (CLIENT_ID, REFRESH_TOKEN), or Method 3 (API_TOKEN) in .env',
		);
	}

	readonly userAgent: string;
}

export class BeatportReleaseLookup extends ReleaseApiLookup<BeatportProvider, BeatportRelease> {
	constructReleaseApiUrl(): URL {
		if (this.lookup.method === 'gtin') {
			const url = new URL('catalog/releases/', this.provider.apiBaseUrl);
			url.searchParams.set('upc', this.lookup.value);
			return url;
		}

		return new URL(`catalog/releases/${this.lookup.value}/`, this.provider.apiBaseUrl);
	}

	async getRawRelease(): Promise<BeatportRelease> {
		let releaseId = this.lookup.value;

		if (this.lookup.method === 'gtin') {
			const id = await this.searchReleaseByGtin(this.lookup.value);
			if (!id) {
				throw new ProviderError(this.provider.name, `Search returned no matching results for '${this.lookup.value}'`);
			}

			releaseId = id;
		}

		const releaseApiUrl = new URL(`catalog/releases/${releaseId}`, this.provider.apiBaseUrl);
		const { content: release, timestamp } = await this.provider.query<Release>(
			releaseApiUrl,
			{ snapshotMaxTimestamp: this.options.snapshotMaxTimestamp },
		);
		this.updateCacheTime(timestamp);

		const trackObjects = await this.getRawTracklist(releaseId);

		return { ...release, track_objects: trackObjects };
	}

	async searchReleaseByGtin(gtin: string): Promise<string | undefined> {
		// Beatport requires exact barcode zero-padding (issue #63). For example, 12-digit UPCs
		// are often stored without leading zero, while external sources may query them with leading zero.
		const candidates = [gtin];
		if (gtin.startsWith('0')) {
			candidates.push(gtin.replace(/^0+/, ''));
		}

		for (const candidate of candidates) {
			const apiUrl = new URL('catalog/releases/', this.provider.apiBaseUrl);
			apiUrl.searchParams.set('upc', candidate);

			const { content, timestamp } = await this.provider.query<PaginatedResult<Release>>(apiUrl, {
				snapshotMaxTimestamp: this.options.snapshotMaxTimestamp,
			});
			this.updateCacheTime(timestamp);

			const releases = content.results;
			if (releases?.length) {
				return releases[0].id.toString();
			}
		}

		return undefined;
	}

	private async getRawTracklist(releaseId: string | number): Promise<Track[]> {
		// Unlike the legacy web scraper which reversed track URLs, REST API v4 returns
		// tracks in natural ascending order (issue #138). Paginating fetches all tracks (issue #200).
		const tracks: Track[] = [];
		let page = 1;
		let hasNext = true;

		while (hasNext) {
			const tracksApiUrl = new URL(`catalog/releases/${releaseId}/tracks/`, this.provider.apiBaseUrl);
			tracksApiUrl.searchParams.set('page', page.toString());
			tracksApiUrl.searchParams.set('per_page', '100');

			const { content, timestamp } = await this.provider.query<PaginatedResult<Track>>(tracksApiUrl, {
				snapshotMaxTimestamp: this.options.snapshotMaxTimestamp,
			});
			this.updateCacheTime(timestamp);

			tracks.push(...content.results);
			hasNext = content.next !== null && tracks.length < content.count;
			page++;
		}

		return tracks;
	}

	convertRawRelease(rawRelease: BeatportRelease): HarmonyRelease {
		this.entity = {
			id: rawRelease.id.toString(),
			slug: rawRelease.slug,
			type: 'release',
		};
		const releaseUrl = this.provider.constructUrl(this.entity);

		const linkTypes: LinkType[] = ['paid download'];
		if (rawRelease.is_available_for_streaming) {
			linkTypes.push('paid streaming');
		}

		return {
			title: rawRelease.name,
			// Beatport accumulates all track artists as release artist, even if it should be VA instead.
			// @todo Properly differentiate between VA and releases with main and many featured artists.
			artists: rawRelease.artists.length > 4
				? [variousArtists]
				: rawRelease.artists.map(this.makeArtistCreditName.bind(this)),
			labels: [{
				name: rawRelease.label.name,
				catalogNumber: rawRelease.catalog_number ?? undefined,
				externalIds: this.provider.makeExternalIds({
					type: 'label',
					id: rawRelease.label.id.toString(),
					slug: rawRelease.label.slug,
				}),
			}],
			gtin: rawRelease.upc ?? undefined,
			releaseDate: this.convertReleaseDate(parseHyphenatedDate(rawRelease.new_release_date)),
			media: [{
				format: 'Digital Media',
				tracklist: rawRelease.track_objects.map(this.convertRawTrack.bind(this)),
			}],
			externalLinks: [{
				url: releaseUrl.href,
				types: linkTypes,
			}],
			status: 'Official',
			packaging: 'None',
			images: [{
				url: rawRelease.image.uri,
				thumbUrl: rawRelease.image.dynamic_uri.replace('{w}x{h}', '250x250'),
				types: ['front'],
			}],
			info: this.generateReleaseInfo(),
		};
	}

	convertRawTrack(rawTrack: Track, index: number): HarmonyTrack {
		let title = rawTrack.name;
		if (rawTrack.mix_name !== 'Original Mix') {
			title += ` (${rawTrack.mix_name})`;
		}

		return {
			number: index + 1,
			title: title,
			artists: rawTrack.artists.map(this.makeArtistCreditName.bind(this)),
			length: rawTrack.length_ms,
			isrc: rawTrack.isrc ?? undefined,
			recording: {
				externalIds: this.provider.makeExternalIds({ type: 'track', id: rawTrack.id.toString(), slug: rawTrack.slug }),
			},
		};
	}

	makeArtistCreditName(artist: Artist): ArtistCreditName {
		return {
			name: artist.name,
			creditedName: artist.name,
			externalIds: this.provider.makeExternalIds({
				type: 'artist',
				id: artist.id.toString(),
				slug: artist.slug,
			}),
		};
	}
}
