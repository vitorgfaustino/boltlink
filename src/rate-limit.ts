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
 * Rate limiting in-memory para endpoints /api/* e redirect publico.
 *
 * CONSTANTES (altere aqui para ajustar os limites):
 *   API_RATE_LIMIT      → requisições permitidas por janela
 *   API_RATE_WINDOW_MS  → duração da janela em milissegundos
 *   PUBLIC_REDIRECT_RATE_LIMIT → leituras publicas por IP/janela antes do D1
 *
 * Para aumentar o limite, edite API_RATE_LIMIT e faça o deploy.
 * Não requer migration de banco nem alteração de schema.
 *
 * Observação: estes limites são locais ao isolate/colo e existem para
 * poupar D1 em rajadas. Bloqueio antes do Worker depende de recursos
 * gratuitos do painel Cloudflare, como Bot Fight Mode, ou de recursos
 * pagos/por plano quando o operador optar por eles.
 */
const API_RATE_LIMIT = 120;
const API_RATE_WINDOW_MS = 60_000;
const PUBLIC_REDIRECT_RATE_LIMIT = 120;
const PUBLIC_REDIRECT_RATE_WINDOW_MS = 60_000;
const CLEANUP_THRESHOLD = 500;

type RateEntry = {
	count: number;
	windowStart: number;
};

const apiRateStore = new Map<string, RateEntry>();
const publicRedirectRateStore = new Map<string, RateEntry>();
let requestCounter = 0;
let rateLimitSalt: string | null = null;

function getRateLimitSalt(): string {
	if (!rateLimitSalt) {
		rateLimitSalt = crypto.randomUUID();
	}
	return rateLimitSalt;
}

function getWindowStart(timestamp: number, windowMs: number): number {
	return Math.floor(timestamp / windowMs) * windowMs;
}

function cleanupOldEntries(store: Map<string, RateEntry>, currentWindow: number, windowMs: number): void {
	const cutoff = currentWindow - windowMs * 2;
	for (const [key, entry] of store) {
		if (entry.windowStart < cutoff) {
			store.delete(key);
		}
	}
}

async function hashIdentifier(identifier: string): Promise<string> {
	const encoded = new TextEncoder().encode(`${getRateLimitSalt()}:${identifier}`);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function consumeRateLimit(store: Map<string, RateEntry>, identifier: string, limit: number, windowMs: number): Promise<number> {
	const hashedIdentifier = await hashIdentifier(identifier);
	const now = Date.now();
	const currentWindow = getWindowStart(now, windowMs);

	requestCounter++;
	if (requestCounter % 100 === 0 || store.size > CLEANUP_THRESHOLD) {
		cleanupOldEntries(store, currentWindow, windowMs);
	}

	const existing = store.get(hashedIdentifier);
	if (existing && existing.windowStart === currentWindow) {
		if (existing.count >= limit) {
			return Math.max(1, Math.ceil((currentWindow + windowMs - now) / 1000));
		}
		existing.count++;
	} else {
		store.set(hashedIdentifier, { count: 1, windowStart: currentWindow });
	}

	return 0;
}

export async function rateLimitMiddleware(c: { req: { header: (name: string) => string | undefined; path: string }; json: (data: Record<string, unknown>, status?: number) => Response }, next: () => Promise<void>) {
	const ip = c.req.header("CF-Connecting-IP") || "unknown";
	const retryAfter = await consumeRateLimit(apiRateStore, `${ip}/api`, API_RATE_LIMIT, API_RATE_WINDOW_MS);
	if (retryAfter) {
		const response = c.json({ error: "Rate limit exceeded" }, 429);
		response.headers.set("Retry-After", String(retryAfter));
		return response;
	}

	await next();
}

export async function consumePublicRedirectBudget(request: Request): Promise<boolean> {
	const ip = request.headers.get("CF-Connecting-IP") || "unknown";
	return (await consumeRateLimit(
		publicRedirectRateStore,
		`${ip}/public-redirect`,
		PUBLIC_REDIRECT_RATE_LIMIT,
		PUBLIC_REDIRECT_RATE_WINDOW_MS,
	)) === 0;
}

export function resetRateLimitStore(): void {
	apiRateStore.clear();
	publicRedirectRateStore.clear();
	requestCounter = 0;
	rateLimitSalt = null;
}
