const DB_NAME = 'plv-secure-exam';
const DB_VERSION = 1;
const STATE_STORE = 'exam_state';
const QUEUE_STORE = 'exam_queue';
const MAX_QUEUE_ITEMS = 500;

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return resolve(null);
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        const store = db.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
        store.createIndex('assessment', 'assessmentId', { unique: false });
        store.createIndex('created', 'createdAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB could not be opened.'));
  });
}

function transaction(db, storeName, mode, task) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve(null);
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    try { result = task(store); } catch (error) { reject(error); return; }
    tx.oncomplete = () => resolve(result?.result ?? result ?? null);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction was aborted.'));
  });
}

export class ExamOfflineStore {
  constructor(assessmentId) {
    this.assessmentId = String(assessmentId || 'unknown');
    this.dbPromise = openDatabase().catch(() => null);
    this.memoryState = null;
    this.memoryQueue = [];
  }

  get stateKey() { return `assessment:${this.assessmentId}`; }

  async saveState(value) {
    const record = {
      key: this.stateKey,
      assessmentId: this.assessmentId,
      value: value && typeof value === 'object' ? value : {},
      updatedAt: new Date().toISOString()
    };
    this.memoryState = record;
    const db = await this.dbPromise;
    if (!db) return record;
    await transaction(db, STATE_STORE, 'readwrite', store => store.put(record));
    return record;
  }

  async loadState() {
    const db = await this.dbPromise;
    if (!db) return this.memoryState?.value || null;
    return new Promise(resolve => {
      const tx = db.transaction(STATE_STORE, 'readonly');
      const request = tx.objectStore(STATE_STORE).get(this.stateKey);
      request.onsuccess = () => resolve(request.result?.value || null);
      request.onerror = () => resolve(this.memoryState?.value || null);
    });
  }

  async clearState() {
    this.memoryState = null;
    const db = await this.dbPromise;
    if (!db) return;
    await transaction(db, STATE_STORE, 'readwrite', store => store.delete(this.stateKey));
  }

  async enqueue(type, payload) {
    const record = {
      id: String(payload?.client_event_id || payload?.id || `${type}_${crypto.randomUUID?.() || Date.now()}`),
      assessmentId: this.assessmentId,
      type,
      payload: payload && typeof payload === 'object' ? payload : {},
      createdAt: Date.now()
    };
    this.memoryQueue.push(record);
    this.memoryQueue = this.memoryQueue.slice(-MAX_QUEUE_ITEMS);
    const db = await this.dbPromise;
    if (!db) return record;
    await transaction(db, QUEUE_STORE, 'readwrite', store => store.put(record));
    await this.trimQueue();
    return record;
  }

  async listQueue() {
    const db = await this.dbPromise;
    if (!db) return this.memoryQueue.slice().sort((a, b) => a.createdAt - b.createdAt);
    return new Promise(resolve => {
      const tx = db.transaction(QUEUE_STORE, 'readonly');
      const request = tx.objectStore(QUEUE_STORE).index('assessment').getAll(this.assessmentId);
      request.onsuccess = () => resolve((request.result || []).sort((a, b) => a.createdAt - b.createdAt));
      request.onerror = () => resolve(this.memoryQueue.slice().sort((a, b) => a.createdAt - b.createdAt));
    });
  }

  async removeQueueItem(id) {
    this.memoryQueue = this.memoryQueue.filter(item => item.id !== id);
    const db = await this.dbPromise;
    if (!db) return;
    await transaction(db, QUEUE_STORE, 'readwrite', store => store.delete(id));
  }

  async clearQueue() {
    const items = await this.listQueue();
    this.memoryQueue = [];
    const db = await this.dbPromise;
    if (!db) return;
    await transaction(db, QUEUE_STORE, 'readwrite', store => {
      items.forEach(item => store.delete(item.id));
    });
  }

  async trimQueue() {
    const items = await this.listQueue();
    const overflow = items.length - MAX_QUEUE_ITEMS;
    if (overflow <= 0) return;
    for (const item of items.slice(0, overflow)) await this.removeQueueItem(item.id);
  }
}
