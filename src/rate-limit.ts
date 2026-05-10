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
 *
 * ---
 * DISCLAIMER / ISENÇÃO DE RESPONSABILIDADE:
 * This software is provided "as is", without warranty of any kind.
 * Vitor Faustino (vitorfaustino.com.br) is not liable for any damages, 
 * losses, or inaccurate results arising from the use of this software.
 * 
 * Este software é fornecido "como está", sem garantias de qualquer tipo.
 * Vitor Faustino (vitorfaustino.com.br) não se responsabiliza por quaisquer
 * danos, perdas ou resultados imprecisos decorrentes do uso deste software.
 */

// src/rate-limit.ts

/**
 * Rate limiting in-memory para endpoints /api/*.
 *
 * CONSTANTES (altere aqui para ajustar os limites):
 *   API_RATE_LIMIT      → requisições permitidas por janela
 *   API_RATE_WINDOW_MS  → duração da janela em milissegundos
 *
 * Para aumentar o limite, edite API_RATE_LIMIT e faça o deploy.
 * Não requer migration de banco nem alteração de schema.
 *
 * EVOLUÇÃO FUTURA:
 * Se o projeto crescer para múltiplos operadores simultâneos ou
 * múltiplas regiões, considere migrar para Cloudflare Rate Limiting
 * (WAF Rules) em vez de D1 — o D1 adicionaria latência de rede a
 * cada request e consumiria cota de leitura/escrita. As WAF Rules
 * são pagas, mas oferecem consistência global e zero latência de
 * aplicação.
 */
const API_RATE_LIMIT = 30;
const API_RATE_WINDOW_MS = 60_000;
const CLEANUP_THRESHOLD = 500;

type RateEntry = {
	count: number;
	windowStart: number;
};

const rateStore = new Map<string, RateEntry>();
let requestCounter = 0;

function getWindowStart(timestamp: number): number {
	return Math.floor(timestamp / API_RATE_WINDOW_MS) * API_RATE_WINDOW_MS;
}

function cleanupOldEntries(currentWindow: number): void {
	const cutoff = currentWindow - API_RATE_WINDOW_MS * 2;
	for (const [key, entry] of rateStore) {
		if (entry.windowStart < cutoff) {
			rateStore.delete(key);
		}
	}
}

async function hashIdentifier(identifier: string): Promise<string> {
	const encoded = new TextEncoder().encode(identifier);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function rateLimitMiddleware(c: { req: { header: (name: string) => string | undefined; path: string }; json: (data: Record<string, unknown>, status?: number) => Response }, next: () => Promise<void>) {
	const ip = c.req.header("CF-Connecting-IP") || "unknown";
	const identifier = await hashIdentifier(ip + "/api");
	const now = Date.now();
	const currentWindow = getWindowStart(now);

	// Lazy cleanup every 100 requests
	requestCounter++;
	if (requestCounter % 100 === 0 || rateStore.size > CLEANUP_THRESHOLD) {
		cleanupOldEntries(currentWindow);
	}

	const existing = rateStore.get(identifier);
	if (existing && existing.windowStart === currentWindow) {
		if (existing.count >= API_RATE_LIMIT) {
			return c.json({ error: "Rate limit exceeded" }, 429);
		}
		existing.count++;
	} else {
		rateStore.set(identifier, { count: 1, windowStart: currentWindow });
	}

	await next();
}

export function resetRateLimitStore(): void {
	rateStore.clear();
	requestCounter = 0;
}
