/*
 * Copyright (c) 2026 Vitor Faustino
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Uniform random integer in [0, 100) used only by the stateless A/B split.
 * Rejection sampling removes the modulo bias of a single byte.
 */
export function randomPercent(): number {
	const bytes = new Uint8Array(1);
	do {
		crypto.getRandomValues(bytes);
	} while (bytes[0] >= 200);
	return bytes[0] % 100;
}
