import { withTx, type LeaderDb } from '../../src/db/repo.js';

// Compiled but never invoked: an async callback must fail the public type contract.
export function transactionTypeContract(db: LeaderDb): void {
  db.withTx(() => undefined);
  db.withTx(() => 1);
  db.withTx(() => db.agents.all());
  // @ts-expect-error async transactions can commit before awaited writes
  db.withTx(async () => undefined);
  // @ts-expect-error indirectly returned promises are also disallowed
  db.withTx(() => Promise.resolve(1));
  // @ts-expect-error standalone helper enforces the same contract
  withTx(db, () => Promise.resolve());
}
