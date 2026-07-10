import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://zjyqqjurnfxqkczrcjph.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_VS-d2c5pMZFwAeMhIw3HVw_uQc1yC5G";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const DOC_KEY_COLUMNS = {
    users: ["id", "studentNo", "uid"],
    subjects: ["id", "subjectCode"],
    sections: ["id", "sectionName", "section"],
    class_schedules: ["id"],
    enrollments: ["id"],
    activities: ["id"],
    scores: ["id"],
    attendance: ["id"],
    settings: ["id"],
    deadlines: ["id"],
    announcements: ["id"],
    sharedFiles: ["id"]
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function generateId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function keyColumns(table) {
    return DOC_KEY_COLUMNS[table] || ["id"];
}

function toTimestampLike(value) {
    const date = value instanceof Date ? value : new Date(value);
    return {
        toDate: () => new Date(date),
        toMillis: () => date.getTime(),
        valueOf: () => date.getTime(),
        toString: () => date.toISOString(),
        toJSON: () => date.toISOString()
    };
}

function materializeValue(key, value) {
    if (value == null) return value;
    if ((key.endsWith("At") || key === "createdAt" || key === "uploadedAt") && (value instanceof Date || (typeof value === "string" && ISO_DATE_RE.test(value)))) {
        return toTimestampLike(value);
    }
    return value;
}

function materializeRow(row) {
    const out = {};
    Object.entries(row || {}).forEach(([key, value]) => {
        out[key] = materializeValue(key, value);
    });
    return out;
}

function normalizeValue(value) {
    if (value instanceof Date) return value.toISOString();
    if (value && typeof value === "object" && typeof value.toDate === "function") return value.toDate().toISOString();
    return value;
}

function normalizePayload(data) {
    const payload = {};
    Object.entries(data || {}).forEach(([key, value]) => {
        payload[key] = normalizeValue(value);
    });
    return payload;
}

function deriveId(table, row) {
    for (const key of keyColumns(table)) {
        if (row && row[key] != null && row[key] !== "") return String(row[key]);
    }
    return row?.id ? String(row.id) : "";
}

function payloadForDoc(ref, data) {
    const payload = normalizePayload(data);
    if (ref.id && payload.id == null) payload.id = ref.id;
    if (ref.table === "users" && payload.studentNo == null && payload.role === "student") payload.studentNo = ref.id;
    if (ref.table === "subjects" && payload.subjectCode == null) payload.subjectCode = ref.id;
    if (ref.table === "sections" && payload.sectionName == null) payload.sectionName = ref.id;
    if (ref.table === "settings" && payload.id == null) payload.id = ref.id;
    return payload;
}

function throwSupabase(error) {
    if (!error) return;
    const wrapped = new Error(error.message || "Supabase request failed");
    wrapped.code = error.code;
    wrapped.details = error.details;
    wrapped.hint = error.hint;
    throw wrapped;
}

async function findDocument(ref) {
    if (!ref?.id) return null;
    for (const key of keyColumns(ref.table)) {
        const { data, error } = await supabase.from(ref.table).select("*").eq(key, ref.id).limit(1);
        if (error) continue;
        if (data && data.length > 0) return { row: data[0], key };
    }
    return null;
}

class DocumentSnapshot {
    constructor(ref, row, exists = true) {
        this.ref = ref;
        this.id = ref.id;
        this._row = row || null;
        this._exists = exists;
    }
    exists() { return this._exists; }
    data() { return materializeRow(this._row); }
}

class QuerySnapshot {
    constructor(table, rows) {
        this.docs = (rows || []).map(row => {
            const id = deriveId(table, row);
            return new DocumentSnapshot({ kind: "doc", table, id }, row, true);
        });
        this.size = this.docs.length;
        this.empty = this.docs.length === 0;
    }
    forEach(callback) { this.docs.forEach(callback); }
}

export function initializeApp() {
    return { supabase };
}

export function getSupabase() {
    return supabase;
}

export function getAuth() {
    return supabase.auth;
}

export async function signInWithEmailAndPassword(auth, email, password) {
    const { data, error } = await auth.signInWithPassword({ email, password });
    if (error) {
        const wrapped = new Error(error.message);
        wrapped.code = "auth/invalid-credential";
        throw wrapped;
    }
    return { user: { ...data.user, uid: data.user.id } };
}

export function collection(dbOrRef, table) {
    return { kind: "collection", table, constraints: [] };
}

export function doc(dbOrCollection, tableOrId, id) {
    if (dbOrCollection?.kind === "collection") {
        return { kind: "doc", table: dbOrCollection.table, id: tableOrId || generateId() };
    }
    return { kind: "doc", table: tableOrId, id };
}

export function where(field, operator, value) {
    return { type: "where", field, operator, value };
}

export function orderBy(field, direction = "asc") {
    return { type: "orderBy", field, direction };
}

export function limit(count) {
    return { type: "limit", count };
}

export function query(base, ...constraints) {
    return { ...base, constraints: [...(base.constraints || []), ...constraints] };
}

function applyConstraints(builder, constraints = []) {
    let request = builder;
    constraints.forEach(constraint => {
        if (constraint.type === "where") {
            const value = normalizeValue(constraint.value);
            if (constraint.operator === "==") request = request.eq(constraint.field, value);
            else if (constraint.operator === "in") request = request.in(constraint.field, value);
            else if (constraint.operator === "!=") request = request.neq(constraint.field, value);
            else if (constraint.operator === ">") request = request.gt(constraint.field, value);
            else if (constraint.operator === ">=") request = request.gte(constraint.field, value);
            else if (constraint.operator === "<") request = request.lt(constraint.field, value);
            else if (constraint.operator === "<=") request = request.lte(constraint.field, value);
        } else if (constraint.type === "orderBy") {
            request = request.order(constraint.field, { ascending: constraint.direction !== "desc" });
        } else if (constraint.type === "limit") {
            request = request.limit(constraint.count);
        }
    });
    return request;
}

export async function getDocs(ref) {
    const request = applyConstraints(supabase.from(ref.table).select("*"), ref.constraints);
    const { data, error } = await request;
    throwSupabase(error);
    return new QuerySnapshot(ref.table, data || []);
}

export async function getDoc(ref) {
    const found = await findDocument(ref);
    if (!found) return new DocumentSnapshot(ref, null, false);
    return new DocumentSnapshot({ ...ref, id: deriveId(ref.table, found.row) }, found.row, true);
}

async function insertRow(table, payload) {
    const { data, error } = await supabase.from(table).insert(payload).select("*").limit(1);
    throwSupabase(error);
    return data?.[0] || payload;
}

async function updateFound(ref, data, found) {
    const payload = normalizePayload(data);
    const matchValue = found.row[found.key];
    const { data: rows, error } = await supabase.from(ref.table).update(payload).eq(found.key, matchValue).select("*").limit(1);
    throwSupabase(error);
    return rows?.[0] || { ...found.row, ...payload };
}

export async function addDoc(collectionRef, data) {
    const ref = doc(collectionRef, generateId());
    const payload = payloadForDoc(ref, data);
    const row = await insertRow(ref.table, payload);
    return { ...ref, id: deriveId(ref.table, row) || ref.id };
}

export async function setDoc(ref, data, options = {}) {
    const payload = payloadForDoc(ref, data);
    const found = await findDocument(ref);
    if (found) return updateFound(ref, payload, found);
    return insertRow(ref.table, payload);
}

export async function updateDoc(ref, data) {
    const found = await findDocument(ref);
    if (!found) throw new Error(`Document not found: ${ref.table}/${ref.id}`);
    return updateFound(ref, data, found);
}

export async function deleteDoc(ref) {
    const found = await findDocument(ref);
    if (!found) return;
    const { error } = await supabase.from(ref.table).delete().eq(found.key, found.row[found.key]);
    throwSupabase(error);
}

export function writeBatch() {
    const ops = [];
    return {
        set(ref, data, options) { ops.push(() => setDoc(ref, data, options)); },
        update(ref, data) { ops.push(() => updateDoc(ref, data)); },
        delete(ref) { ops.push(() => deleteDoc(ref)); },
        async commit() { await Promise.all(ops.map(run => run())); }
    };
}

export function onSnapshot(ref, next, error) {
    getDocs(ref).then(next).catch(err => { if (error) error(err); else console.error(err); });
    return () => {};
}

export function serverTimestamp() {
    return new Date().toISOString();
}