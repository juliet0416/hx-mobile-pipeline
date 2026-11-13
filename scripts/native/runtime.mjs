import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const toolchain = JSON.parse(readFileSync(new URL('./toolchain.json', import.meta.url)));

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');