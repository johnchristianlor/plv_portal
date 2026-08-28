import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const publicDir = path.join(root, 'public');
const read = file => fs.readFileSync(path.join(publicDir, file), 'utf8');
const htmlFiles = fs.readdirSync(publicDir).filter(file => file.endsWith('.html'));

test('portal queries do not use wildcard selects', () => {
    const offenders = [];
    for (const file of [...htmlFiles, ...fs.readdirSync(publicDir).filter(name => name.endsWith('.js'))]) {
        const source = read(file);
        if (/\.select\(\s*['"]\*['"]\s*\)/.test(source)) offenders.push(file);
    }
    assert.deepEqual(offenders, []);
});

test('large optional browser vendors are loaded only by the shared action loader', () => {
    const eager = [];
    for (const file of htmlFiles) {
        if (/<script[^>]+src=["'][^"']*(?:xlsx|papaparse|qrcode|jsqr)[^"']*["']/i.test(read(file))) eager.push(file);
    }
    assert.deepEqual(eager, []);
    const loader = read('vendor-loader.v1.js').toLowerCase();
    for (const name of ['xlsx', 'papaparse', 'qrcodejs', 'jsqr']) assert.match(loader, new RegExp(name));
});

test('performance-sensitive assets and counts use the optimized paths', () => {
    assert.match(read('index.html'), /f_auto,q_auto,w_1344/);
    assert.match(read('plv-responsive.css'), /font-display:swap/g);
    const dashboard = read('admin-dashboard.html');
    assert.match(dashboard, /count:\s*'exact',\s*head:\s*true/);
    assert.doesNotMatch(dashboard, /const\s+students\s*=\s*studentsResult\.data/);
    const headers = read('_headers');
    assert.match(headers, /\/\*\.v1\.js\s+[\s\S]*Cache-Control:\s*public, max-age=31536000, immutable/);
    assert.match(headers, /\/\*\.html\s+[\s\S]*Cache-Control:\s*public, max-age=0, must-revalidate/);
});

test('every portal page uses the global responsive application system', () => {
    for (const file of htmlFiles) {
        const source = read(file);
        assert.match(source, /plv-responsive\.css\?v=20260826global1/, `${file} must load the current responsive stylesheet`);
        assert.match(source, /<meta name="viewport" content="[^"]*viewport-fit=cover[^"]*">/, `${file} must support mobile safe areas`);
        assert.doesNotMatch(source, /user-scalable=no|maximum-scale=1/, `${file} must allow accessible pinch zoom`);
    }
    const responsive = read('plv-responsive.css');
    for (const expected of [
        '--plv-touch-target', ':focus-visible', '@media (pointer:coarse)',
        '@media (max-width:360px)', 'orientation:landscape',
        'env(safe-area-inset-bottom)', 'ul:not(:has(>li:nth-child(7)))'
    ]) assert.match(responsive, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('shared-file queries retain the fields needed by upload and legacy download flows', () => {
    const adminSettings = read('admin-settings.html');
    const studentSettings = read('student-settings.html');
    assert.match(adminSettings, /sharedFiles:\s*'[^']*b2FileId[^']*b2FileName[^']*storage[^']*'/);
    assert.match(studentSettings, /\.select\('[^']*fileUrl[^']*b2FileName[^']*storage[^']*'\)/);
    assert.match(studentSettings, /\.in\('recipientStudentNo',\s*\['all',\s*studentId\]\)/);
});

test('student attendance shows a responsive professional records table', () => {
    const attendance = read('student-attendance.html');
    assert.match(attendance, /class="card glass records-card"/);
    assert.match(attendance, /id="attendanceRecordsTable"/);
    assert.match(attendance, /id="attendanceTableBody"/);
    assert.match(attendance, /id="filterSubject"[^>]+applyAttendanceFilter/);
    assert.match(attendance, /class="attendance-record-row"/);
    assert.match(attendance, /class="status-badge status-/);
    assert.match(attendance, /ph-fill ph-check-circle/);
    assert.match(attendance, /ph-fill ph-clock-countdown/);
    assert.match(attendance, /@media \(max-width:768px\)[\s\S]*\.attendance-records-table thead \{ position:static;/);
    assert.match(attendance, /@media \(max-width:360px\)[\s\S]*\.status-badge \{ min-width:58px;/);
    assert.match(attendance, /\.history-legend \{ display:none; \}/);
    assert.match(attendance, /\.bento-grid>\.stat-card \.stat-copy \{ width:min\(100%,88px\) !important;[\s\S]*align-items:stretch !important;/);
    assert.match(attendance, /\.bento-grid>\.stat-card \.stat-label,\.bento-grid>\.stat-card \.stat-value \{ display:flex !important; width:100% !important;[\s\S]*justify-content:center !important;/);
    assert.match(attendance, /\.bento-grid>\.stat-card \.att-progress \{ width:100%; margin:5px auto 0; \}/);
    assert.match(attendance, /\.bento-grid>\.stat-card \{ min-height:154px !important;[\s\S]*flex-direction:column !important;/);
    assert.doesNotMatch(attendance, /id="matrixTable"|matrix-wrap|applyMatrixFilter|attendanceHistory/);
    assert.doesNotMatch(attendance, /grid-template-areas:'date status'/);
});

test('admin attendance uses an enrolled-student spreadsheet with autosaved status popover editing', () => {
    const attendance = read('admin-attendance.html');
    assert.match(attendance, /formatLocalDateInput/);
    assert.match(attendance, /id="rosterAutosaveState"/);
    assert.match(attendance, /function queueRosterSave/);
    assert.match(attendance, /class="attendance-history-table"/);
    assert.match(attendance, /id="recordStatusPopover"/);
    assert.match(attendance, /window\.saveSheetStatus/);
    assert.match(attendance, /fetchRows\('enrollments', query => query\.eq\('section', section\)\.eq\('subjectCode', subjectCode\)\)/);
    assert.match(attendance, /id="filterSearch"/);
    assert.doesNotMatch(attendance, /id="editModal"|id="btnListView"|id="btnSheetView"|id="recordsBody"|class="records-table"/);
});

test('admin attendance can safely delete one class date from the spreadsheet', () => {
    const attendance = read('admin-attendance.html');
    assert.match(attendance, /class="sheet-date-delete"/);
    assert.match(attendance, /id="deleteDateModal"[^>]+role="dialog"[^>]+aria-modal="true"/);
    assert.match(attendance, /window\.openDeleteDateModal/);
    assert.match(attendance, /window\.confirmDeleteDate/);
    assert.match(attendance, /deleteAttendanceSession\(section, subjectCode, date\)/);
    assert.match(attendance, /from\('attendance'\)\.delete\(\)[\s\S]{0,180}\.eq\('section', section\)[\s\S]{0,180}\.eq\('subjectCode', subjectCode\)[\s\S]{0,180}\.eq\('date', date\)/);
    assert.match(attendance, /Student enrollments and all other dates stay unchanged/);
});

test('inline and shared browser modules remain syntactically valid', () => {
    const failures = [];
    for (const file of htmlFiles) {
        const source = read(file);
        for (const [index, match] of [...source.matchAll(/<script\s+type=["']module["']\s*>([\s\S]*?)<\/script>/gi)].entries()) {
            const body = match[1].replace(/^\s*import\s+[^;]+;\s*$/gm, '');
            try { new Function(body); }
            catch (error) { failures.push(`${file} inline module ${index + 1}: ${error.message}`); }
        }
    }
    for (const file of ['student-data.js', 'student-notifications.js', 'vendor-loader.v1.js']) {
        const body = read(file)
            .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
            .replace(/\bexport\s+(?=(?:const|function|class)\b)/g, '');
        try { new Function(body); }
        catch (error) { failures.push(`${file}: ${error.message}`); }
    }
    assert.deepEqual(failures, []);
});

test('performance index migration is query-backed and leaves RLS untouched', () => {
    const migration = fs.readFileSync(path.join(root, 'supabase_migrations', '20260825_performance_indexes.sql'), 'utf8');
    for (const expected of [
        'enrollments_student_subject_idx', 'enrollments_section_subject_idx',
        'activities_subject_section_term_category_title_idx', 'scores_activity_student_idx',
        'attendance_section_subject_date_student_idx', 'shared_files_recipient_uploaded_at_idx'
    ]) assert.match(migration, new RegExp(expected));
    assert.doesNotMatch(migration, /(?:disable\s+row\s+level\s+security|create\s+policy|drop\s+policy)/i);
});
