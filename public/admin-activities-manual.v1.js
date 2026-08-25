export function parseActivityScore(rawValue, perfectScore) {
    const text = String(rawValue ?? '').trim();
    if (text === '') return { kind: 'blank', value: null };

    const value = Number(text);
    const maximum = Number(perfectScore);
    if (!Number.isFinite(value) || !Number.isFinite(maximum) || maximum <= 0 || value < 0 || value > maximum) {
        return { kind: 'invalid', value: null };
    }

    return { kind: 'score', value };
}

export function planActivityScoreChanges(entries, existingScores, perfectScore) {
    const changes = {
        inserts: [],
        updates: [],
        deletes: [],
        invalid: [],
        gradedCount: 0,
        unchangedCount: 0
    };

    for (const entry of entries) {
        const studentNo = String(entry.studentNo ?? '').trim();
        if (!studentNo) continue;

        const parsed = parseActivityScore(entry.value, perfectScore);
        const existing = existingScores.get(studentNo);

        if (parsed.kind === 'invalid') {
            changes.invalid.push(studentNo);
            continue;
        }

        if (parsed.kind === 'blank') {
            if (existing?.id) changes.deletes.push({ id: existing.id, studentNo });
            continue;
        }

        changes.gradedCount++;
        if (!existing?.id) {
            changes.inserts.push({ studentNo, score: parsed.value });
        } else if (Number(existing.score) !== parsed.value) {
            changes.updates.push({ id: existing.id, studentNo, score: parsed.value });
        } else {
            changes.unchangedCount++;
        }
    }

    return changes;
}
