/**
 * Cash and share balances, each split into `available` and `reserved`.
 *
 * Placing an order reserves what it could spend: a limit buy reserves
 * quantity × limit price in cash, and a sell reserves the shares. Reservation
 * is what stops one account from promising the same rupee or share to two
 * orders. A trade then moves value out of reserved balances into the
 * counterparty's available balance.
 *
 * Every mutation checks that no balance goes negative. A failure here is an
 * engine bug, not a user error, so it throws rather than returning a result.
 */

import { MoneyError, ZERO, add, paise, subtract, type Paise } from "./money.js";

export interface Balance<T extends number> {
  available: T;
  reserved: T;
}

export interface AccountSnapshot {
  readonly id: string;
  readonly cash: Readonly<Balance<Paise>>;
  readonly positions: Readonly<Record<string, Readonly<Balance<number>>>>;
}

interface AccountState {
  readonly id: string;
  cash: Balance<Paise>;
  positions: Map<string, Balance<number>>;
}

export class InvariantError extends Error {
  override name = "InvariantError";
}

export class Accounts {
  private readonly accounts = new Map<string, AccountState>();
  /** Total cash and shares ever deposited; trades must never change these sums. */
  private depositedCash: Paise = ZERO;
  private readonly depositedShares = new Map<string, number>();

  open(id: string, cash: Paise, holdings: Readonly<Record<string, number>> = {}): void {
    if (this.accounts.has(id)) throw new Error(`Account ${id} already exists`);
    if (cash < 0) throw new MoneyError("Opening cash cannot be negative");
    const positions = new Map<string, Balance<number>>();
    for (const [symbol, qty] of Object.entries(holdings)) {
      if (!Number.isSafeInteger(qty) || qty < 0) {
        throw new MoneyError(`Opening holding for ${symbol} must be a whole number`);
      }
      positions.set(symbol, { available: qty, reserved: 0 });
      this.depositedShares.set(symbol, (this.depositedShares.get(symbol) ?? 0) + qty);
    }
    this.accounts.set(id, { id, cash: { available: cash, reserved: ZERO }, positions });
    this.depositedCash = add(this.depositedCash, cash);
  }

  has(id: string): boolean {
    return this.accounts.has(id);
  }

  ids(): string[] {
    return [...this.accounts.keys()];
  }

  private state(id: string): AccountState {
    const account = this.accounts.get(id);
    if (!account) throw new InvariantError(`Unknown account ${id}`);
    return account;
  }

  private position(id: string, symbol: string): Balance<number> {
    const account = this.state(id);
    let position = account.positions.get(symbol);
    if (!position) {
      position = { available: 0, reserved: 0 };
      account.positions.set(symbol, position);
    }
    return position;
  }

  availableCash(id: string): Paise {
    return this.state(id).cash.available;
  }

  availableShares(id: string, symbol: string): number {
    return this.accounts.get(id)?.positions.get(symbol)?.available ?? 0;
  }

  // Cash -----------------------------------------------------------------

  /** available → reserved */
  reserveCash(id: string, amount: Paise): void {
    const cash = this.state(id).cash;
    if (amount > cash.available)
      throw new InvariantError(`${id}: reserving more cash than available`);
    cash.available = subtract(cash.available, amount);
    cash.reserved = add(cash.reserved, amount);
  }

  /** reserved → available */
  releaseCash(id: string, amount: Paise): void {
    const cash = this.state(id).cash;
    if (amount > cash.reserved)
      throw new InvariantError(`${id}: releasing more cash than reserved`);
    cash.reserved = subtract(cash.reserved, amount);
    cash.available = add(cash.available, amount);
  }

  /** Pays out of reserved cash. */
  debitReservedCash(id: string, amount: Paise): void {
    const cash = this.state(id).cash;
    if (amount > cash.reserved) throw new InvariantError(`${id}: spending more cash than reserved`);
    cash.reserved = subtract(cash.reserved, amount);
  }

  /** Pays out of available cash (market buys, which reserve nothing up front). */
  debitAvailableCash(id: string, amount: Paise): void {
    const cash = this.state(id).cash;
    if (amount > cash.available)
      throw new InvariantError(`${id}: spending more cash than available`);
    cash.available = subtract(cash.available, amount);
  }

  creditCash(id: string, amount: Paise): void {
    const cash = this.state(id).cash;
    cash.available = add(cash.available, amount);
  }

  // Shares ---------------------------------------------------------------

  reserveShares(id: string, symbol: string, qty: number): void {
    const position = this.position(id, symbol);
    if (qty > position.available)
      throw new InvariantError(`${id}: reserving more ${symbol} than held`);
    position.available -= qty;
    position.reserved += qty;
  }

  releaseShares(id: string, symbol: string, qty: number): void {
    const position = this.position(id, symbol);
    if (qty > position.reserved)
      throw new InvariantError(`${id}: releasing more ${symbol} than reserved`);
    position.reserved -= qty;
    position.available += qty;
  }

  debitReservedShares(id: string, symbol: string, qty: number): void {
    const position = this.position(id, symbol);
    if (qty > position.reserved)
      throw new InvariantError(`${id}: delivering more ${symbol} than reserved`);
    position.reserved -= qty;
  }

  creditShares(id: string, symbol: string, qty: number): void {
    this.position(id, symbol).available += qty;
  }

  // Reads ----------------------------------------------------------------

  snapshot(id: string): AccountSnapshot {
    const account = this.state(id);
    const positions: Record<string, Balance<number>> = {};
    for (const [symbol, balance] of account.positions) {
      if (balance.available + balance.reserved > 0) positions[symbol] = { ...balance };
    }
    return { id, cash: { ...account.cash }, positions };
  }

  /** Conservation check: trades move value between accounts, never create or destroy it. */
  auditConservation(): string[] {
    const problems: string[] = [];
    let cash = 0;
    const shares = new Map<string, number>();
    for (const account of this.accounts.values()) {
      if (account.cash.available < 0 || account.cash.reserved < 0) {
        problems.push(`${account.id}: negative cash balance`);
      }
      cash += account.cash.available + account.cash.reserved;
      for (const [symbol, p] of account.positions) {
        if (p.available < 0 || p.reserved < 0) problems.push(`${account.id}: negative ${symbol}`);
        shares.set(symbol, (shares.get(symbol) ?? 0) + p.available + p.reserved);
      }
    }
    if (paise(cash) !== this.depositedCash) {
      problems.push(`cash not conserved: ${cash} held vs ${this.depositedCash} deposited`);
    }
    for (const symbol of new Set([...this.depositedShares.keys(), ...shares.keys()])) {
      const held = shares.get(symbol) ?? 0;
      const deposited = this.depositedShares.get(symbol) ?? 0;
      if (held !== deposited) problems.push(`${symbol} not conserved: ${held} vs ${deposited}`);
    }
    return problems;
  }

  /** Reserved balances as recorded, for comparison with open orders. */
  reserved(id: string): { cash: Paise; shares: Map<string, number> } {
    const account = this.state(id);
    const shares = new Map<string, number>();
    for (const [symbol, p] of account.positions) shares.set(symbol, p.reserved);
    return { cash: account.cash.reserved, shares };
  }
}
