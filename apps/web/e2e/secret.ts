/**
 * The end-to-end server's token secret (playwright.config.ts), so a test can
 * sign a guest token as the server does, for a session that has ended. Used
 * only by that test server.
 */
export const E2E_TOKEN_SECRET = "e2e-only-token-secret-0123456789abcdef";
