'use strict';

const { ApiError } = require('./VoyagerError');

const MAX_BYTES = 1024 * 1024;
const MAX_RECORDS = 2048;
const MAX_RECORD_BYTES = 512 * 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const RECORD_ID = /^[0-9a-f]+$/i;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function schemaChanged() {
	return new ApiError('UPSTREAM_SCHEMA_CHANGED');
}

function validateJson(value) {
	const pending = [{ value, depth: 0 }];
	let nodes = 0;
	while (pending.length) {
		const current = pending.pop();
		if (!current || current.depth > MAX_DEPTH || ++nodes > MAX_NODES)
			throw schemaChanged();
		if (Array.isArray(current.value)) {
			for (const item of current.value)
				pending.push({ value: item, depth: current.depth + 1 });
		} else if (current.value && typeof current.value === 'object') {
			for (const [key, item] of Object.entries(current.value)) {
				if (FORBIDDEN_KEYS.has(key))
					throw schemaChanged();
				pending.push({ value: item, depth: current.depth + 1 });
			}
		}
	}
}

function parseValue(tag, source) {
	if (tag === 'T')
		return source;
	try {
		return JSON.parse(source);
	} catch (error) {
		if (tag)
			throw schemaChanged();
		return source;
	}
}

class RscFlight {
	constructor(records) {
		this.records = records;
	}

	static parse(value) {
		const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
		if (data.length === 0 || data.length > MAX_BYTES)
			throw schemaChanged();
		const records = new Map();
		let position = 0;
		while (position < data.length) {
			while (data[position] === 10 || data[position] === 13)
				position += 1;
			if (position >= data.length)
				break;
			const recordStart = position;
			const colon = data.indexOf(58, position);
			if (colon < 0)
				throw schemaChanged();
			const id = data.subarray(position, colon).toString('ascii').toLowerCase();
			if (!RECORD_ID.test(id) || records.has(id) || records.size >= MAX_RECORDS)
				throw schemaChanged();
			position = colon + 1;
			let tag = '';
			if (position < data.length && data[position] >= 65 && data[position] <= 90) {
				tag = String.fromCharCode(data[position]);
				position += 1;
			}

			let body;
			if (tag === 'T') {
				const comma = data.indexOf(44, position);
				if (comma < 0)
					throw schemaChanged();
				const rawLength = data.subarray(position, comma).toString('ascii');
				if (!/^[0-9a-f]+$/i.test(rawLength))
					throw schemaChanged();
				const length = Number.parseInt(rawLength, 16);
				const start = comma + 1;
				const end = start + length;
				if (!Number.isSafeInteger(length) || length > MAX_RECORD_BYTES || end > data.length)
					throw schemaChanged();
				body = data.subarray(start, end).toString('utf8');
				position = end;
			} else {
				const newline = data.indexOf(10, position);
				let end = newline < 0 ? data.length : newline;
				if (end > position && data[end - 1] === 13)
					end -= 1;
				if (end - position > MAX_RECORD_BYTES)
					throw schemaChanged();
				body = data.subarray(position, end).toString('utf8');
				position = newline < 0 ? data.length : newline + 1;
			}
			if (position - recordStart > MAX_RECORD_BYTES + 128)
				throw schemaChanged();
			const parsed = parseValue(tag, body);
			validateJson(parsed);
			records.set(id, { value: parsed, isImport: tag === 'I' });
		}
		if (!records.size)
			throw schemaChanged();
		return new RscFlight(records);
	}
}

module.exports = { RscFlight };
