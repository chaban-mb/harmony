export interface PaginatedResult<T> {
	count: number;
	next: string | null;
	previous: string | null;
	page: string;
	per_page: number;
	results: T[];
}

export interface Entity {
	id: number;
	name: string;
}

export interface EntityWithUrl extends Entity {
	url: string;
}

export interface Artist extends EntityWithUrl {
	image?: Image;
	slug: string;
}

/**
 * Beatport's OpenAPI spec incorrectly documents `image` as `{ "type": "string" }`,
 * but runtime API responses actually return an image object with `id`, `uri`, and `dynamic_uri`.
 */
export interface Image {
	id: number;
	uri: string;
	dynamic_uri: string;
}

export interface Label extends Entity {
	image?: Image;
	slug: string;
	url?: string;
}

export interface BpmRange {
	min: number;
	max: number;
}

export interface Price {
	code: string;
	symbol: string;
	value: number;
	display: string;
}

export interface MinimalRelease extends Entity {
	image: Image;
	label: Label;
	slug: string;
}

export interface Release extends MinimalRelease {
	artists: Artist[];
	bpm_range?: BpmRange;
	catalog_number: string | null;
	desc?: string | null;
	enabled: boolean;
	encoded_date?: string | null;
	exclusive: boolean;
	grid?: string | null;
	is_available_for_streaming: boolean;
	is_dj_edit?: boolean;
	is_dj_version?: boolean;
	is_explicit?: boolean;
	is_hype?: boolean | string;
	is_ugc_remix?: boolean;
	new_release_date: string;
	override_price?: string | boolean | null;
	pre_order: boolean;
	pre_order_date?: string | null;
	price?: Price;
	price_override_firm?: boolean | null;
	publish_date: string;
	remixers: Artist[];
	tracks: string[];
	track_count: number;
	type?: Entity;
	upc: string | null;
	updated?: string | null;
}

export interface Genre extends EntityWithUrl {
	slug: string;
}

export interface Key extends EntityWithUrl {
	camelot_number: number;
	camelot_letter: string;
	chord_type: EntityWithUrl;
	is_sharp: boolean;
	is_flat: boolean;
	letter: string;
}

export interface Track extends EntityWithUrl {
	artists: Artist[];
	audio_format?: string | null;
	available_worldwide?: boolean;
	bpm?: number | null;
	bsrc_remixer?: Artist[] | string | null;
	catalog_number?: string;
	current_status?: EntityWithUrl;
	desc?: string | null;
	enabled?: boolean;
	encode_status?: string;
	encoded_date?: string;
	exclusive?: boolean;
	free_downloads?: [];
	free_download_start_date?: string | null;
	free_download_end_date?: string | null;
	genre?: Genre;
	hidden?: boolean;
	image?: Image;
	is_available_for_streaming?: boolean;
	is_classic?: boolean;
	is_dj_edit?: boolean;
	is_dj_version?: boolean;
	is_explicit?: boolean;
	is_hype?: boolean;
	is_ugc_remix?: boolean;
	isrc: string | null;
	key?: Key;
	label_track_identifier?: string | null;
	length?: string;
	length_ms: number;
	mix_name: string;
	new_release_date?: string;
	number?: number;
	pre_order?: boolean;
	pre_order_date?: string | null;
	price?: Price;
	publish_date?: string;
	publish_status?: string;
	release: MinimalRelease;
	remixers: Artist[];
	sale_type?: EntityWithUrl;
	sample_url?: string;
	sample_start_ms?: number;
	sample_end_ms?: number;
	slug: string;
	sub_genre?: Genre | null;
	territories?: string[];
	was_ever_exclusive?: boolean;
}

export interface BeatportRelease extends Release {
	track_objects: Track[];
}
