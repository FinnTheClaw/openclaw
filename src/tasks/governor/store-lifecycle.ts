import {
  closeOpenClawStateDatabaseAtPath,
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";

/** Owns the store's database handle lifecycle and rejects retained capabilities after close. */
export class GovernorStoreLifecycle {
  readonly #databasePath: string;
  #closed = false;
  #admissionFrozen = false;

  constructor(readonly options: OpenClawStateDatabaseOptions) {
    this.#databasePath = openOpenClawStateDatabase(options).path;
  }

  assertOpen(): void {
    if (this.#closed) {
      throw new Error("GOVERNOR_HOST_CAPABILITY_CLOSED");
    }
  }

  assertAdmissionOpen(): void {
    this.assertOpen();
    if (this.#admissionFrozen) {
      throw new Error("GOVERNOR_HOST_ADMISSION_FROZEN");
    }
  }

  freezeAdmissions(): void {
    this.assertOpen();
    this.#admissionFrozen = true;
  }

  database() {
    this.assertOpen();
    return openOpenClawStateDatabase(this.options);
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    try {
      closeOpenClawStateDatabaseAtPath(this.#databasePath);
    } finally {
      this.#closed = true;
    }
  }
}
