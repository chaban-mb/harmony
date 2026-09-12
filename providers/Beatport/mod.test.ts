// Automatically load .env environment variable file (before anything else).
import '@std/dotenv/load';

import type { ReleaseOptions } from '@/harmonizer/types.ts';
import { describeProvider, makeProviderOptions } from '@/providers/test_spec.ts';
import { stubProviderLookups, stubTokenRetrieval } from '@/providers/test_stubs.ts';
import { downloadMode } from '@/utils/fetch_stub.ts';
import { afterAll, describe } from '@std/testing/bdd';
import type { Stub } from '@std/testing/mock';
import { assertSnapshot } from '@std/testing/snapshot';
import { assert } from 'std/assert/assert.ts';
import { assertEquals } from 'std/assert/assert_equals.ts';

import BeatportProvider from './mod.ts';

describe('Beatport provider', () => {
	const beatport = new BeatportProvider(makeProviderOptions());
	const stubs: Stub[] = [stubProviderLookups(beatport, {
		ignoreTrailingSlash: false,
	})];

	if (!downloadMode) {
		stubs.push(stubTokenRetrieval(beatport));
	}

	const releaseOptions: ReleaseOptions = {
		withISRC: true,
	};

	describeProvider(beatport, {
		urls: [{
			description: 'release URL with slug',
			url: new URL('https://www.beatport.com/release/black-mill-tapes-10th-anniversary-box/3176998'),
			id: { type: 'release', id: '3176998', slug: 'black-mill-tapes-10th-anniversary-box' },
			isCanonical: true,
		}, {
			description: 'artist URL with slug',
			url: new URL('https://www.beatport.com/artist/deadmau5/26182'),
			id: { type: 'artist', id: '26182', slug: 'deadmau5' },
			isCanonical: true,
		}, {
			description: 'label URL with slug',
			url: new URL('https://www.beatport.com/label/physical-techno-recordings/41056'),
			id: { type: 'label', id: '41056', slug: 'physical-techno-recordings' },
			isCanonical: true,
		}, {
			description: 'track URL with slug',
			url: new URL('https://www.beatport.com/track/tokyo-night/19209410'),
			id: { type: 'track', id: '19209410', slug: 'tokyo-night' },
			isCanonical: true,
		}],
		invalidIds: ['text'],
		releaseLookup: [{
			description: 'release with multiple tracks and ISRCs',
			release: new URL('https://www.beatport.com/release/guriddo-hacked/6787727'),
			options: releaseOptions,
			assert: async (release, ctx) => {
				await assertSnapshot(ctx, release);
				assertEquals(release.title, 'Guriddo Hacked');
				assertEquals(release.gtin, '663918962466');
				assertEquals(release.media.length, 1);
				assertEquals(release.media[0].tracklist.length, 6);
				assert(release.media[0].tracklist[0].isrc, 'Track should have an ISRC');
			},
		}, {
			description: 'release lookup by GTIN',
			release: 663918962466,
			options: releaseOptions,
			assert: async (release, ctx) => {
				await assertSnapshot(ctx, release);
				assertEquals(release.title, 'Guriddo Hacked');
				assertEquals(release.gtin, '663918962466');
			},
		}],
	});

	afterAll(() => {
		stubs.forEach((s) => s.restore());
	});
});
