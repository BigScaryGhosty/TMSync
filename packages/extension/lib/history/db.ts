export const HISTORY_DB_NAME = "tmsync-watch-history";
export const HISTORY_DB_VERSION = 1;

/** Open only on the extension origin (background), never on a streaming origin. */
export function openHistoryDatabase(name = HISTORY_DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(name, HISTORY_DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      // Add future migrations in ascending oldVersion blocks, preserving the ledger.
      if (event.oldVersion < 1) {
        const sessions = db.createObjectStore("sessions", { keyPath: "id" });
        sessions.createIndex("mediaKey", "mediaKey");
        sessions.createIndex("startedAt", "startedAt");
        const events = db.createObjectStore("events", { keyPath: "id" });
        events.createIndex("sessionId", "sessionId");
        events.createIndex("occurredAt", "occurredAt");
        db.createObjectStore("syncRecords", { keyPath: ["sessionId", "tracker"] });
        const owners = db.createObjectStore("owners", { keyPath: "key" });
        owners.createIndex("tabId", "tabId");
      }
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error("History database upgrade blocked"));
    };
    request.onsuccess = () => {
      if (blocked) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

export function readRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("History transaction aborted"));
    tx.onerror = () => reject(tx.error);
  });
}
