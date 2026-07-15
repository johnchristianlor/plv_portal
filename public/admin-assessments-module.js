import { supabase } from './supabase-adapter.js';
import { startAdminSessionGuard } from './admin-session.js';
import { normalizeSecurityConfig, MODE_DEFAULTS, SECURITY_MODE_LABELS } from './exam-security-config.js';
import { INCIDENT_CODES, incidentLabel, canonicalIncidentCode } from './exam-incident-codes.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const user = JSON.parse(localStorage.getItem('loggedInUser') || 'null');
if (!user || user.role !== 'admin') location.href = 'index.html';

const guard = startAdminSessionGuard(supabase, user);
window.logout = () => {
    guard.stop();
    localStorage.removeItem('loggedInUser');
    supabase.auth.signOut().catch(() => {});
    location.href = 'index.html';
};

let editing = null;
let questions = [];
let sections = [];
let activeSectionId = '';
let choiceDraft = [];
let correctChoiceIndex = 0;
let questionBankDraft = [];
let smartPasteCache = [];
let inlinePasteUndo = null;
let smartPasteLastFocus = null;
let questionReviewLastFocus = null;
let assessments = [];
let assessmentListFilters = { search: '', status: 'all', section: 'all' };
let duplicateSourceId = '';
let incidentCache = [];
let incidentAssessmentFilterId = null;
let incidentTypeFilter = 'all';
let incidentSearch = '';
let incidentSearchTimer = null;
let incidentNextCursor = null;
let incidentHasMore = false;
let incidentFilters = { section: 'all', student: '', attempt: '', session: '', severity: 'all', review: 'all', submission: 'all', category: 'all', dateFrom: '', dateTo: '' };
let auditReviewIncidentId = '';
let auditReviewAttemptId = '';
let autosaveTimer = null;
let draftPersistTimer = null;
let lastAutosaveSignature = '';
let currentWorkspace = 'tests';
const DRAFT_KEY = 'plv-admin-assessment-draft-v2';

const pageParams = new URLSearchParams(location.search);
// Older versions opened the assessment editor in a standalone browser tab.
// Keep old bookmarked URLs working, but always render inside the normal admin page.
const standaloneMode = false;
const requestedWorkspace = pageParams.get('workspace') || 'tests';
const requestedAssessmentId = pageParams.get('id') || '';
const requestedNew = pageParams.get('new') === '1';
if (pageParams.has('standalone')) {
    const normalizedUrl = new URL(location.href);
    normalizedUrl.searchParams.delete('standalone');
    history.replaceState({}, '', normalizedUrl);
}
const adminChannel = 'BroadcastChannel' in window ? new BroadcastChannel('plv-admin-assessments') : null;

function uid(prefix = 'id') {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function toRoman(value) {
    const number = Math.max(1, Math.floor(Number(value) || 1));
    const pairs = [
        [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
        [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
        [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
    ];
    let remaining = number;
    let result = '';
    for (const [amount, symbol] of pairs) {
        while (remaining >= amount) {
            result += symbol;
            remaining -= amount;
        }
    }
    return result;
}

function defaultSectionTitle(index = sections.length) {
    return `Section ${toRoman(index + 1)}`;
}


const QUESTION_TYPE_META = {
    multiple_choice: {
        name: 'Multiple Choice', icon: 'ph-list-bullets',
        help: 'Paste the question together with choices A, B, C, and D. Smart Paste can detect the correct answer from “Answer: B”.',
        format: '<b>Fastest method:</b> paste a full block such as <code>Question + A. choice + B. choice + Answer: B</code>. The choices and answer will fill automatically.',
        button: 'Add Multiple Choice Question'
    },
    true_false: {
        name: 'True or False', icon: 'ph-check-square',
        help: 'Enter a statement, then choose whether the correct answer is True or False.',
        format: 'You may paste <code>The statement...\\nAnswer: True</code> and the correct answer will be selected automatically.',
        button: 'Add True or False Question'
    },
    short_answer: {
        name: 'Identification', icon: 'ph-textbox',
        help: 'Enter the question and provide the accepted short answer.',
        format: 'You may paste <code>Question...\\nAnswer: accepted answer</code> to fill both fields automatically.',
        button: 'Add Identification Question'
    },
    essay: {
        name: 'Essay', icon: 'ph-article',
        help: 'Enter an open-ended question. The teacher will grade the response manually.',
        format: 'Type or paste only the essay prompt. No answer key is required.',
        button: 'Add Essay Question'
    }
};

function syncGuidedQuestionTypeUi(type = $('qType')?.value || 'multiple_choice', reveal = false) {
    const meta = QUESTION_TYPE_META[type] || QUESTION_TYPE_META.multiple_choice;
    document.querySelectorAll('[data-question-type]').forEach(button => {
        button.classList.toggle('selected', button.dataset.questionType === type);
        button.setAttribute('aria-pressed', button.dataset.questionType === type ? 'true' : 'false');
    });
    const panel = $('questionEditorPanel');
    if (panel && reveal) panel.hidden = false;
    if ($('selectedTypeName')) $('selectedTypeName').textContent = meta.name;
    if ($('selectedTypeHelp')) $('selectedTypeHelp').textContent = meta.help;
    if ($('questionFormatHelp')) $('questionFormatHelp').innerHTML = meta.format;
    if ($('addQuestionButtonText')) $('addQuestionButtonText').textContent = meta.button;
    if ($('selectedTypeIcon')) $('selectedTypeIcon').innerHTML = `<i class="ph-fill ${meta.icon}"></i>`;
}

function chooseGuidedQuestionType(type, options = {}) {
    if (!QUESTION_TYPE_META[type]) return;
    const typeSelect = $('qType');
    if (typeSelect) {
        typeSelect.value = type;
        typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    syncGuidedQuestionTypeUi(type, true);
    if (options.scroll !== false) $('questionEditorPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (options.focus !== false) setTimeout(() => $('qPrompt')?.focus(), 280);
    $('questionEditorPanel')?.classList.remove('question-editor-flash');
    requestAnimationFrame(() => $('questionEditorPanel')?.classList.add('question-editor-flash'));
}

function closeGuidedQuestionEditor({ clear = false, scroll = true } = {}) {
    if (clear) {
        if ($('qPrompt')) $('qPrompt').value = '';
        if ($('qPoints')) $('qPoints').value = '1';
        if ($('qAnswer')) $('qAnswer').value = '';
        choiceDraft = [];
        correctChoiceIndex = 0;
        renderChoiceEditor();
        updateAnswerKeyUi();
    }
    if ($('questionEditorPanel')) $('questionEditorPanel').hidden = true;
    document.querySelectorAll('[data-question-type]').forEach(button => button.classList.remove('selected'));
    if (scroll) $('questionTypeStep')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setupGuidedQuestionBuilder() {
    const picker = $('questionTypePicker');
    if (picker && !picker.dataset.bound) {
        picker.dataset.bound = '1';
        picker.addEventListener('click', event => {
            const button = event.target.closest('[data-question-type]');
            if (button) chooseGuidedQuestionType(button.dataset.questionType);
        });
    }
    const changeButton = $('changeQuestionTypeBtn');
    if (changeButton && !changeButton.dataset.bound) {
        changeButton.dataset.bound = '1';
        changeButton.addEventListener('click', () => closeGuidedQuestionEditor({ clear: false }));
    }
    const cancelButton = $('cancelQuestionBtn');
    if (cancelButton && !cancelButton.dataset.bound) {
        cancelButton.dataset.bound = '1';
        cancelButton.addEventListener('click', () => closeGuidedQuestionEditor({ clear: true }));
    }
    const hasDraftContent = !!$('qPrompt')?.value.trim();
    syncGuidedQuestionTypeUi($('qType')?.value || 'multiple_choice', hasDraftContent);
}

function createSection(title = '') {
    return {
        id: uid('sec'),
        title: String(title || '').trim() || defaultSectionTitle(sections.length),
        pickCount: 0,
        shuffleQuestions: false,
        shuffleChoices: false,
        collapsed: false
    };
}

function normalizeSection(section, index) {
    const cleanTitle = String(section?.title || '').trim();
    return {
        id: String(section?.id || uid('sec')),
        title: cleanTitle || defaultSectionTitle(index),
        pickCount: Math.max(0, Number(section?.pickCount || 0)),
        shuffleQuestions: !!section?.shuffleQuestions,
        shuffleChoices: !!section?.shuffleChoices,
        collapsed: !!section?.collapsed
    };
}

function normalizeQuestion(question, fallbackSectionId) {
    return {
        id: String(question?.id || uid('q')),
        sectionId: String(question?.sectionId || question?.category || fallbackSectionId || ''),
        type: question?.type || 'multiple_choice',
        prompt: String(question?.prompt || ''),
        points: Math.max(1, Number(question?.points || 1)),
        answer_key: String(question?.answer_key || ''),
        choices: Array.isArray(question?.choices) ? question.choices.map(choice => String(choice)) : [],
        order_no: Number(question?.order_no || 1)
    };
}

function normalizeBuilderState() {
    sections = Array.isArray(sections) ? sections.map((section, index) => normalizeSection(section, index)) : [];
    if (!sections.length) {
        const inferredIds = [];
        questions.forEach(question => {
            const category = String(question?.sectionId || question?.category || '').trim();
            if (category && !inferredIds.includes(category)) inferredIds.push(category);
        });
        sections = inferredIds.length ? inferredIds.map((sectionId, index) => ({
            id: sectionId,
            title: sectionId || defaultSectionTitle(index),
            pickCount: 0,
            shuffleQuestions: false,
            shuffleChoices: false,
            collapsed: false
        })) : [createSection()];
    }
    const sectionIds = new Set(sections.map(section => section.id));
    const fallbackSectionId = sections[0].id;
    questions = Array.isArray(questions) ? questions.map((question, index) => {
        const clean = normalizeQuestion(question, fallbackSectionId);
        if (!sectionIds.has(clean.sectionId)) clean.sectionId = fallbackSectionId;
        clean.order_no = Number.isFinite(Number(clean.order_no)) ? Number(clean.order_no) : index + 1;
        return clean;
    }) : [];
    if (!sectionIds.has(activeSectionId)) activeSectionId = fallbackSectionId;
}

function builderSettingsSnapshot() {
    return sections.map(section => {
        const bankCount = questions.filter(question => question.sectionId === section.id).length;
        const requested = Math.max(0, Math.floor(Number(section.pickCount || 0)));
        const pickCount = requested > 0 && requested < bankCount ? requested : 0;
        return {
            id: section.id,
            title: String(section.title || '').trim() || 'Untitled Section',
            pickCount,
            shuffleQuestions: !!section.shuffleQuestions,
            shuffleChoices: !!section.shuffleChoices,
            collapsed: !!section.collapsed
        };
    });
}

function questionDraftFromUi() {
    return choiceDraft.map(choice => String(choice ?? '').trim()).filter(Boolean);
}

function renderSectionSelect() {
    const options = sections.map(section => `<option value="${esc(section.id)}" ${section.id === activeSectionId ? 'selected' : ''}>${esc(section.title)}</option>`).join('');
    const select = $('qSection');
    if (select) select.innerHTML = options;
    const smartSelect = $('smartPasteSection');
    if (smartSelect) smartSelect.innerHTML = options;
}

function initChoiceDraft(type) {
    if (type === 'true_false') {
        choiceDraft = ['True', 'False'];
        correctChoiceIndex = 0;
        return;
    }
    if (!Array.isArray(choiceDraft) || choiceDraft.length < 2) choiceDraft = ['', ''];
    if (correctChoiceIndex >= choiceDraft.length) correctChoiceIndex = 0;
}

function renderChoiceEditor() {
    const wrap = $('choiceWrap');
    if (!wrap) return;
    const type = $('qType')?.value || 'multiple_choice';
    const show = type === 'multiple_choice' || type === 'true_false';
    const fixedChoices = type === 'true_false';
    wrap.style.display = show ? '' : 'none';
    if (!show) {
        wrap.innerHTML = '';
        return;
    }

    initChoiceDraft(type);
    wrap.innerHTML = `
        <div class="choice-editor-shell">
            <div class="choice-editor-head">
                <div>
                    <label>Choices — select correct answer</label>
                    <p class="mini">${fixedChoices ? 'True or False uses two fixed choices.' : 'Add options, then select the correct answer.'}</p>
                </div>
                ${fixedChoices ? '' : '<button type="button" class="btn secondary btn-sm" id="addChoiceRowBtn"><i class="ph-bold ph-plus"></i> Add Option</button>'}
            </div>
            <div class="choice-editor-list" id="choiceRows"></div>
        </div>`;

    const rows = $('choiceRows');
    if (!rows) return;

    const renderRows = () => {
        rows.innerHTML = choiceDraft.map((choice, index) => `
            <div class="choice-row ${index === correctChoiceIndex ? 'selected' : ''}" data-choice-row="${index}">
                <input class="choice-radio" type="radio" name="qCorrect" value="${index}" ${index === correctChoiceIndex ? 'checked' : ''} aria-label="Mark choice ${index + 1} as correct">
                <span class="choice-letter">${String.fromCharCode(65 + index)}</span>
                <input class="input choice-input" data-choice-input="${index}" value="${esc(choice)}" placeholder="Option ${index + 1}" ${fixedChoices ? 'readonly' : ''}>
                ${fixedChoices ? '<span class="choice-fixed"><i class="ph-bold ph-lock-key"></i></span>' : `<button class="btn danger btn-icon choice-remove" data-remove-choice="${index}" type="button" aria-label="Remove option ${index + 1}" title="Remove option"><i class="ph-bold ph-x"></i></button>`}
            </div>`).join('') + (fixedChoices ? '' : `
            <button class="choice-add-btn" id="addChoiceRowInline" type="button"><i class="ph-bold ph-plus"></i> Add Option</button>`);
    };

    renderRows();
    rows.oninput = event => {
        const target = event.target;
        if (target.matches('[data-choice-input]') && !fixedChoices) {
            choiceDraft[Number(target.dataset.choiceInput)] = target.value;
        }
    };
    rows.onchange = event => {
        const target = event.target;
        if (target.matches('.choice-radio')) {
            correctChoiceIndex = Number(target.value);
            renderRows();
        }
    };
    rows.onclick = event => {
        const remove = event.target.closest('[data-remove-choice]');
        if (remove) {
            const index = Number(remove.dataset.removeChoice);
            if (choiceDraft.length <= 2) return toast('Keep at least two choices.');
            choiceDraft.splice(index, 1);
            if (correctChoiceIndex === index) correctChoiceIndex = Math.max(0, index - 1);
            else if (correctChoiceIndex > index) correctChoiceIndex -= 1;
            if (correctChoiceIndex >= choiceDraft.length) correctChoiceIndex = choiceDraft.length - 1;
            renderRows();
            return;
        }
        if (event.target.closest('#addChoiceRowInline')) {
            choiceDraft.push('');
            renderRows();
            rows.querySelector(`[data-choice-input="${choiceDraft.length - 1}"]`)?.focus();
        }
    };
    wrap.querySelector('#addChoiceRowBtn')?.addEventListener('click', () => {
        choiceDraft.push('');
        renderRows();
        rows.querySelector(`[data-choice-input="${choiceDraft.length - 1}"]`)?.focus();
    });
}

function updateAnswerKeyUi() {
    const field = $('answerKeyField');
    const input = $('qAnswer');
    if (!field || !input) return;
    const type = $('qType')?.value || 'multiple_choice';
    const show = type === 'short_answer';
    field.style.display = show ? '' : 'none';
    input.placeholder = 'Enter the accepted short answer';
    if (!show) input.value = '';
}


function cleanSmartPasteText(value) {
    return String(value || '')
        .replace(/\u00a0/g, ' ')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/^\s*(?:\*\*|__)(.*?)(?:\*\*|__)\s*$/g, '$1')
        .trim();
}

function isSmartChoiceLine(line) {
    return /^\s*(?:[-•]\s*)?(?:\*{1,2}\s*)?[\(\[]?([A-Za-z])[\.\)\]:\-](?:\s*\*{1,2})?\s+.+/.test(String(line || ''));
}

function isSmartAnswerLine(line) {
    return /^\s*(?:(?:correct\s+)?answer|ans(?:wer)?\s*key|key)\s*[:=\-]\s*.+/i.test(String(line || ''));
}

function isSmartPointsLine(line) {
    return /^\s*(?:points?|pts?)\s*[:=\-]\s*\d+/i.test(String(line || ''));
}

function isSmartNumberedQuestion(line) {
    return /^\s*(?:(?:q(?:uestion)?\s*)?\d+\s*[\.\)\]:\-]\s*)\S+/i.test(String(line || ''));
}

function splitSmartQuestionBlocks(raw) {
    const lines = String(raw || '').replace(/\r/g, '').split('\n');
    const blocks = [];
    let current = [];
    let blankRun = 0;

    const flush = () => {
        const cleaned = current.map(line => line.trim()).filter(Boolean);
        if (cleaned.length) blocks.push(cleaned);
        current = [];
    };

    for (const sourceLine of lines) {
        const line = sourceLine.trim();
        if (!line) {
            blankRun += 1;
            continue;
        }
        if (/^(?:-{3,}|={3,})$/.test(line)) {
            flush();
            blankRun = 0;
            continue;
        }

        const hasAnswer = current.some(isSmartAnswerLine);
        const choiceCount = current.filter(isSmartChoiceLine).length;
        const startsQuestion = isSmartNumberedQuestion(line);
        const isMetadata = isSmartChoiceLine(line) || isSmartAnswerLine(line) || isSmartPointsLine(line);
        const shouldStartNew = current.length && !isMetadata && (
            startsQuestion ||
            hasAnswer ||
            (blankRun >= 2 && choiceCount >= 2) ||
            (blankRun >= 2 && choiceCount === 0)
        );

        if (shouldStartNew) flush();
        current.push(line);
        blankRun = 0;
    }
    flush();
    return blocks;
}

function parseSmartQuestionBlock(lines) {
    if (!Array.isArray(lines) || !lines.length) return null;
    const choicePattern = /^\s*(?:[-•]\s*)?(\*{1,2}\s*)?[\(\[]?([A-Za-z])[\.\)\]:\-](?:\s*\*{1,2})?\s+(.+)$/;
    const answerPattern = /^\s*(?:(?:correct\s+)?answer|ans(?:wer)?\s*key|key)\s*[:=\-]\s*(.+)$/i;
    const pointsPattern = /^\s*(?:points?|pts?)\s*[:=\-]\s*(\d+)/i;
    const questionPrefix = /^\s*(?:(?:q(?:uestion)?\s*)?\d+\s*[\.\)\]:\-]\s*)/i;

    const questionLines = [];
    const choices = [];
    let answerRaw = '';
    let markedLetter = '';
    let points = 1;

    for (const rawLine of lines) {
        const line = String(rawLine || '').trim();
        if (!line) continue;
        const answerMatch = line.match(answerPattern);
        if (answerMatch) {
            answerRaw = cleanSmartPasteText(answerMatch[1]);
            continue;
        }
        const pointsMatch = line.match(pointsPattern);
        if (pointsMatch) {
            points = Math.max(1, Number(pointsMatch[1]) || 1);
            continue;
        }
        const choiceMatch = line.match(choicePattern);
        if (choiceMatch) {
            const letter = choiceMatch[2].toUpperCase();
            let text = cleanSmartPasteText(choiceMatch[3]);
            let marked = !!choiceMatch[1] || /(?:\*{1,2}|✓|✔)\s*$/.test(text) || /^\s*(?:\(correct\)|\[correct\])\s*/i.test(text);
            text = text
                .replace(/^\s*(?:\(correct\)|\[correct\])\s*/i, '')
                .replace(/(?:\*{1,2}|✓|✔)\s*$/, '')
                .trim();
            if (marked && !markedLetter) markedLetter = letter;
            choices.push({ letter, text });
            continue;
        }
        if (/^(?:multiple\s+choice|true\s*(?:or|\/)\s*false|identification|short\s+answer|essay)\s*:?$/i.test(line)) continue;
        questionLines.push(line);
    }

    let prompt = cleanSmartPasteText(questionLines.join(' ')).replace(questionPrefix, '').trim();
    if (!prompt) return null;

    let answerToken = answerRaw || markedLetter;
    if (choices.length >= 2) {
        const choiceTexts = choices.map(choice => choice.text);
        const letters = choices.map(choice => choice.letter);
        const trueFalseChoices = choices.length === 2 && /^true$/i.test(choiceTexts[0]) && /^false$/i.test(choiceTexts[1]);
        let answerIndex = -1;
        if (answerToken) {
            const letterMatch = String(answerToken).trim().match(/^\(?([A-Za-z])\)?(?:[\.\)]|$)/);
            if (letterMatch) answerIndex = letters.indexOf(letterMatch[1].toUpperCase());
            if (answerIndex < 0) answerIndex = choiceTexts.findIndex(choice => choice.trim().toLowerCase() === String(answerToken).trim().toLowerCase());
        }
        const answerKey = answerIndex >= 0 ? choiceTexts[answerIndex] : '';
        const answerLetter = answerIndex >= 0 ? letters[answerIndex] : '';
        if (trueFalseChoices) {
            const tfAnswer = answerKey || (/^false$/i.test(answerToken) || /^b$/i.test(answerToken) ? 'False' : /^true$/i.test(answerToken) || /^a$/i.test(answerToken) ? 'True' : '');
            return {
                type: 'true_false', prompt, choices: ['True', 'False'], answer_key: tfAnswer,
                answer_label: tfAnswer, points, valid: !!tfAnswer,
                warning: tfAnswer ? '' : 'Choose the correct True/False answer before adding.'
            };
        }
        return {
            type: 'multiple_choice', prompt, choices: choiceTexts, answer_key: answerKey,
            answer_label: answerLetter || 'Not detected', points, valid: !!answerKey,
            warning: answerKey ? '' : 'Correct answer was not detected. Select it before adding.'
        };
    }

    if (/^(?:true|false)$/i.test(answerToken)) {
        const answer = /^true$/i.test(answerToken) ? 'True' : 'False';
        prompt = prompt.replace(/^\s*(?:true\s*(?:or|\/)\s*false|t\s*\/\s*f)\s*[:\-–]?\s*/i, '').trim() || prompt;
        return { type: 'true_false', prompt, choices: ['True', 'False'], answer_key: answer, answer_label: answer, points, valid: true, warning: '' };
    }

    if (answerRaw) {
        return { type: 'short_answer', prompt, choices: [], answer_key: answerRaw, answer_label: answerRaw, points, valid: true, warning: '' };
    }

    return { type: 'essay', prompt, choices: [], answer_key: '', answer_label: 'Manual grading', points: Math.max(points, 1), valid: true, warning: '' };
}

function smartParseQuestions(raw) {
    return splitSmartQuestionBlocks(raw).map(parseSmartQuestionBlock).filter(Boolean);
}

function looksLikeStructuredQuestionPaste(text) {
    const value = String(text || '');
    if (!value.includes('\n')) return false;
    return value.split(/\r?\n/).some(line => isSmartChoiceLine(line) || isSmartAnswerLine(line));
}

function captureQuestionEditorState() {
    return {
        type: $('qType')?.value || 'multiple_choice',
        prompt: $('qPrompt')?.value || '',
        points: $('qPoints')?.value || '1',
        answer: $('qAnswer')?.value || '',
        choices: [...choiceDraft],
        correctIndex: correctChoiceIndex
    };
}

function restoreQuestionEditorState(state) {
    if (!state) return;
    $('qType').value = state.type;
    $('qPrompt').value = state.prompt;
    $('qPoints').value = state.points;
    choiceDraft = [...state.choices];
    correctChoiceIndex = Number(state.correctIndex || 0);
    renderChoiceEditor();
    updateAnswerKeyUi();
    if (state.type === 'short_answer') $('qAnswer').value = state.answer;
    syncGuidedQuestionTypeUi(state.type, true);
    inlinePasteUndo = null;
    showInlinePasteFeedback('Smart Paste was undone.', 'neutral', false);
}

function showInlinePasteFeedback(message, tone = 'success', allowUndo = true) {
    const box = $('inlinePasteFeedback');
    if (!box) return;
    box.hidden = false;
    box.className = `inline-paste-feedback ${tone}`;
    box.innerHTML = `<span><i class="ph-bold ${tone === 'warning' ? 'ph-warning' : tone === 'neutral' ? 'ph-arrow-counter-clockwise' : 'ph-check-circle'}"></i>${esc(message)}</span>${allowUndo ? '<button class="btn secondary btn-sm" type="button" id="inlinePasteUndoBtn"><i class="ph-bold ph-arrow-counter-clockwise"></i>Undo</button>' : ''}`;
    if (allowUndo) $('inlinePasteUndoBtn').onclick = () => restoreQuestionEditorState(inlinePasteUndo);
}

function applyParsedQuestionToEditor(parsed) {
    if (!parsed) return;
    $('qType').value = parsed.type;
    $('qPrompt').value = parsed.prompt;
    $('qPoints').value = String(parsed.points || 1);
    $('qAnswer').value = '';
    choiceDraft = Array.isArray(parsed.choices) ? [...parsed.choices] : [];
    if (parsed.type === 'multiple_choice' || parsed.type === 'true_false') {
        const detectedIndex = choiceDraft.findIndex(choice => choice === parsed.answer_key);
        correctChoiceIndex = parsed.answer_key && detectedIndex >= 0 ? detectedIndex : -1;
    } else {
        correctChoiceIndex = 0;
    }
    renderChoiceEditor();
    updateAnswerKeyUi();
    if (parsed.type === 'short_answer') $('qAnswer').value = parsed.answer_key || '';
    syncGuidedQuestionTypeUi(parsed.type, true);
    const typeLabel = {
        multiple_choice: 'Multiple Choice', true_false: 'True or False',
        short_answer: 'Short Answer', essay: 'Essay'
    }[parsed.type] || parsed.type;
    const detail = parsed.type === 'multiple_choice'
        ? `${parsed.choices.length} choices detected${parsed.answer_label && parsed.answer_label !== 'Not detected' ? `; answer ${parsed.answer_label}` : ''}.`
        : parsed.answer_label ? `Answer: ${parsed.answer_label}.` : '';
    showInlinePasteFeedback(`${typeLabel} auto-filled. ${detail}${parsed.warning || ''}`, parsed.warning ? 'warning' : 'success', true);
}

function renderSmartPastePreview(parsed = smartPasteCache) {
    const preview = $('smartPastePreview');
    const importButton = $('smartPasteImport');
    if (!preview || !importButton) return;
    if (!parsed.length) {
        preview.innerHTML = '<p class="mini smart-paste-empty">Paste questions, then click Detect Questions.</p>';
        importButton.disabled = true;
        return;
    }
    const validCount = parsed.filter(question => question.valid).length;
    preview.innerHTML = `
        <div class="smart-paste-result-head"><strong>${parsed.length} question${parsed.length === 1 ? '' : 's'} detected</strong><span>${validCount} ready to import</span></div>
        <div class="smart-paste-preview-list">${parsed.map((question, index) => {
            const label = {
                multiple_choice: 'MC', true_false: 'T/F', short_answer: 'Short', essay: 'Essay'
            }[question.type] || 'Q';
            return `<article class="smart-paste-preview-item ${question.valid ? '' : 'has-warning'}">
                <span class="smart-paste-type">${label}</span>
                <div><strong>Q${index + 1}. ${esc(question.prompt)}</strong><small>${question.type === 'multiple_choice' ? `${question.choices.length} choices • Answer: ${esc(question.answer_label)}` : `Answer: ${esc(question.answer_label || 'Manual grading')}`}${question.warning ? ` • ${esc(question.warning)}` : ''}</small></div>
            </article>`;
        }).join('')}</div>`;
    importButton.disabled = validCount === 0;
    importButton.innerHTML = `<i class="ph-bold ph-download-simple"></i>Import ${validCount} to Selected Section`;
}

function detectSmartPasteQuestions() {
    smartPasteCache = smartParseQuestions($('smartPasteInput')?.value || '');
    renderSmartPastePreview();
    if (!smartPasteCache.length) toast('No supported question blocks were detected.');
}

function mapSmartParsedToQuestion(parsed, sectionId, orderNo) {
    return {
        id: uid('q'), sectionId, type: parsed.type, prompt: parsed.prompt,
        points: Math.max(1, Number(parsed.points || 1)), answer_key: parsed.answer_key || '',
        choices: Array.isArray(parsed.choices) ? [...parsed.choices] : [], order_no: orderNo
    };
}

function importSmartPasteQuestions() {
    const sectionId = $('smartPasteSection')?.value || $('qSection')?.value || activeSectionId || sections[0]?.id || '';
    if (!sectionId) return toast('Create or select a section first.');
    const ready = smartPasteCache.filter(question => question.valid);
    if (!ready.length) return toast('No questions are ready to import.');
    const startOrder = questions.length + 1;
    questions.push(...ready.map((question, index) => mapSmartParsedToQuestion(question, sectionId, startOrder + index)));
    renumberQuestions();
    scheduleAutosave();
    renderQ();
    const section = sections.find(item => item.id === sectionId);
    toast(`Imported ${ready.length} question${ready.length === 1 ? '' : 's'} to ${section?.title || 'the selected section'}.`);
    $('smartPasteInput').value = '';
    smartPasteCache = [];
    renderSmartPastePreview();
    setSmartPastePanel(false);
}

function setSmartPastePanel(open) {
    const modal = $('smartPasteModal');
    if (!modal) return;
    const isOpen = modal.classList.contains('show');
    if (open === isOpen) return;

    if (open) {
        smartPasteLastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        modal.classList.add('show');
        modal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('smart-paste-open');
        requestAnimationFrame(() => $('smartPasteInput')?.focus());
        return;
    }

    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('smart-paste-open');
    const returnTarget = smartPasteLastFocus;
    smartPasteLastFocus = null;
    if (returnTarget?.isConnected) requestAnimationFrame(() => returnTarget.focus());
}

function openSmartPasteForSection(sectionId) {
    activeSectionId = sectionId;
    if ($('qSection')) $('qSection').value = sectionId;
    if ($('smartPasteSection')) $('smartPasteSection').value = sectionId;
    setSmartPastePanel(true);
}

function handleQuestionPromptPaste(event) {
    const text = (event.clipboardData || window.clipboardData)?.getData('text/plain') || '';
    if (!looksLikeStructuredQuestionPaste(text)) return;
    const parsed = smartParseQuestions(text);
    if (!parsed.length) return;
    event.preventDefault();
    if (parsed.length > 1) {
        $('smartPasteInput').value = text;
        smartPasteCache = parsed;
        renderSmartPastePreview();
        setSmartPastePanel(true);
        toast(`${parsed.length} questions detected. Review them, then import.`);
        return;
    }
    inlinePasteUndo = captureQuestionEditorState();
    applyParsedQuestionToEditor(parsed[0]);
}

function setupSmartPasteUi() {
    const prompt = $('qPrompt');
    if (prompt) {
        prompt.onpaste = handleQuestionPromptPaste;
        prompt.placeholder = 'Type a question, or paste a full block with A–D choices and Answer: B';
    }

    if ($('smartPasteToggle')) $('smartPasteToggle').onclick = () => setSmartPastePanel(true);
    if ($('smartPasteClose')) $('smartPasteClose').onclick = () => setSmartPastePanel(false);
    if ($('smartPasteCancel')) $('smartPasteCancel').onclick = () => setSmartPastePanel(false);
    document.querySelectorAll('[data-smart-paste-close]').forEach(element => {
        element.onclick = () => setSmartPastePanel(false);
    });

    if ($('smartPasteDetect')) $('smartPasteDetect').onclick = detectSmartPasteQuestions;
    if ($('smartPasteImport')) $('smartPasteImport').onclick = importSmartPasteQuestions;
    if ($('smartPasteClear')) $('smartPasteClear').onclick = () => {
        $('smartPasteInput').value = '';
        smartPasteCache = [];
        renderSmartPastePreview();
        $('smartPasteInput').focus();
    };
    if ($('smartPasteInput')) {
        $('smartPasteInput').oninput = () => {
            smartPasteCache = [];
            renderSmartPastePreview();
        };
        $('smartPasteInput').onpaste = () => setTimeout(detectSmartPasteQuestions, 0);
    }

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && $('smartPasteModal')?.classList.contains('show')) {
            event.preventDefault();
            setSmartPastePanel(false);
        }
    });
    renderSmartPastePreview();
}


function questionTypeName(type) {
    return QUESTION_TYPE_META[type]?.name || String(type || 'Question').replaceAll('_', ' ');
}

function ensureQuestionReviewModal() {
    if ($('questionReviewModal')) return;
    document.body.insertAdjacentHTML('beforeend', `
        <div class="question-review-modal" id="questionReviewModal" aria-hidden="true">
            <div class="question-review-modal__backdrop" data-question-review-close></div>
            <section class="question-review-dialog" role="dialog" aria-modal="true" aria-labelledby="questionReviewTitle" aria-describedby="questionReviewDescription">
                <header class="question-review-head">
                    <div class="question-review-title">
                        <span class="question-review-title__icon"><i class="ph-fill ph-book-open-text"></i></span>
                        <div>
                            <span class="builder-summary__label">Question review</span>
                            <h2 id="questionReviewTitle">Review all questions</h2>
                            <p id="questionReviewDescription">Read every question in one organized view. Search, filter, and jump directly to an item in the builder.</p>
                        </div>
                    </div>
                    <button class="btn secondary btn-icon question-review-close" type="button" id="questionReviewClose" aria-label="Close question review"><i class="ph-bold ph-x"></i></button>
                </header>
                <div class="question-review-tools">
                    <div class="question-review-search">
                        <i class="ph-bold ph-magnifying-glass"></i>
                        <input class="input" id="questionReviewSearch" type="search" placeholder="Search question, choice, or answer..." autocomplete="off">
                    </div>
                    <select class="select" id="questionReviewSection" aria-label="Filter by section"></select>
                    <select class="select" id="questionReviewType" aria-label="Filter by question type">
                        <option value="">All question types</option>
                        <option value="multiple_choice">Multiple Choice</option>
                        <option value="true_false">True or False</option>
                        <option value="short_answer">Identification</option>
                        <option value="essay">Essay</option>
                    </select>
                    <div class="question-review-count" id="questionReviewCount">0 questions</div>
                </div>
                <div class="question-review-body" id="questionReviewList"></div>
                <footer class="question-review-footer">
                    <p>Tip: use “Locate in builder” to return to the original section and question.</p>
                    <div class="question-review-footer__actions">
                        <button class="btn secondary" type="button" id="questionReviewClearFilters"><i class="ph-bold ph-funnel-x"></i>Clear filters</button>
                        <button class="btn primary" type="button" id="questionReviewDone"><i class="ph-bold ph-check"></i>Done reviewing</button>
                    </div>
                </footer>
            </section>
        </div>`);

    const modal = $('questionReviewModal');
    const close = () => setQuestionReviewModal(false);
    $('questionReviewClose').onclick = close;
    $('questionReviewDone').onclick = close;
    document.querySelectorAll('[data-question-review-close]').forEach(element => { element.onclick = close; });
    $('questionReviewSearch').oninput = renderQuestionReviewList;
    $('questionReviewSection').onchange = renderQuestionReviewList;
    $('questionReviewType').onchange = renderQuestionReviewList;
    $('questionReviewClearFilters').onclick = () => {
        $('questionReviewSearch').value = '';
        $('questionReviewSection').value = '';
        $('questionReviewType').value = '';
        renderQuestionReviewList();
        $('questionReviewSearch').focus();
    };
    $('questionReviewList').onclick = event => {
        const locateButton = event.target.closest('[data-review-locate]');
        if (locateButton) locateQuestionInBuilder(locateButton.dataset.reviewLocate);
    };
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && modal.classList.contains('show')) {
            event.preventDefault();
            close();
        }
    });
}

function setQuestionReviewModal(open) {
    ensureQuestionReviewModal();
    const modal = $('questionReviewModal');
    if (!modal) return;
    const isOpen = modal.classList.contains('show');
    if (open === isOpen) return;
    if (open) {
        questionReviewLastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        renderQuestionReviewFilters();
        renderQuestionReviewList();
        modal.classList.add('show');
        modal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('question-review-open');
        requestAnimationFrame(() => $('questionReviewSearch')?.focus());
        return;
    }
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('question-review-open');
    const returnTarget = questionReviewLastFocus;
    questionReviewLastFocus = null;
    if (returnTarget?.isConnected) requestAnimationFrame(() => returnTarget.focus());
}

function renderQuestionReviewFilters() {
    const select = $('questionReviewSection');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">All sections</option>' + sections.map((section, index) =>
        `<option value="${esc(section.id)}">Section ${toRoman(index + 1)} — ${esc(section.title)}</option>`
    ).join('');
    if ([...select.options].some(option => option.value === current)) select.value = current;
}

function questionMatchesReview(question, searchText) {
    if (!searchText) return true;
    const section = sections.find(item => item.id === question.sectionId);
    const haystack = [section?.title, question.prompt, question.answer_key, ...(question.choices || [])]
        .filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(searchText);
}

function renderQuestionReviewList() {
    const list = $('questionReviewList');
    const count = $('questionReviewCount');
    if (!list || !count) return;
    const searchText = ($('questionReviewSearch')?.value || '').trim().toLowerCase();
    const sectionFilter = $('questionReviewSection')?.value || '';
    const typeFilter = $('questionReviewType')?.value || '';
    const ordered = sections.flatMap(section => sectionQuestions(section.id));
    const filtered = ordered.filter(question =>
        (!sectionFilter || question.sectionId === sectionFilter) &&
        (!typeFilter || question.type === typeFilter) &&
        questionMatchesReview(question, searchText)
    );
    count.textContent = `${filtered.length} question${filtered.length === 1 ? '' : 's'}`;

    if (!filtered.length) {
        list.innerHTML = `<div class="question-review-empty"><div><i class="ph-fill ph-magnifying-glass"></i><strong>No questions found</strong><p>${questions.length ? 'Try changing the search or filters.' : 'Add questions first, then return here to review them.'}</p></div></div>`;
        return;
    }

    const globalIndex = new Map(ordered.map((question, index) => [question.id, index + 1]));
    const groups = sections.map((section, sectionIndex) => ({
        section,
        sectionIndex,
        items: filtered.filter(question => question.sectionId === section.id)
    })).filter(group => group.items.length);

    list.innerHTML = groups.map(group => `
        <section class="question-review-section">
            <div class="question-review-section__head">
                <h3>Section ${toRoman(group.sectionIndex + 1)} — ${esc(group.section.title)}</h3>
                <span>${group.items.length} shown</span>
            </div>
            <div class="question-review-list">
                ${group.items.map(question => {
                    const answer = question.answer_key || 'Manual grading';
                    const choices = Array.isArray(question.choices) ? question.choices : [];
                    const choiceHtml = choices.length ? `<div class="question-review-choices">${choices.map((choice, index) => `
                        <div class="question-review-choice ${choice === question.answer_key ? 'is-correct' : ''}">
                            <span class="question-review-choice__key">${String.fromCharCode(65 + index)}</span>
                            <span>${esc(choice)}</span>
                        </div>`).join('')}</div>` : '';
                    return `<article class="question-review-item">
                        <div class="question-review-item__top">
                            <div class="question-review-item__identity">
                                <span class="question-review-number">Q${globalIndex.get(question.id) || ''}</span>
                                <span class="question-review-type">${esc(questionTypeName(question.type))}</span>
                                <span class="question-review-points">${Number(question.points || 0)} pts</span>
                            </div>
                            <button class="btn secondary question-review-locate" type="button" data-review-locate="${esc(question.id)}"><i class="ph-bold ph-crosshair"></i>Locate in builder</button>
                        </div>
                        <div class="question-review-prompt">${esc(question.prompt || '(No question text)')}</div>
                        ${choiceHtml}
                        <div class="question-review-answer"><span>Answer key:</span><strong>${esc(answer)}</strong></div>
                    </article>`;
                }).join('')}
            </div>
        </section>`).join('');
}

function locateQuestionInBuilder(questionId) {
    const question = questions.find(item => item.id === questionId);
    if (!question) return;
    const section = sections.find(item => item.id === question.sectionId);
    if (section) section.collapsed = false;
    setQuestionReviewModal(false);
    renderQ();
    requestAnimationFrame(() => {
        const card = document.querySelector(`[data-question-card-id="${CSS.escape(questionId)}"]`);
        if (!card) return;
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.remove('question-located');
        requestAnimationFrame(() => card.classList.add('question-located'));
        setTimeout(() => card.classList.remove('question-located'), 1400);
    });
}

function openQuestionReviewManager() {
    setQuestionReviewModal(true);
}

function ensureQuestionBankModal() {
    if ($('questionBankModal')) return;
    document.body.insertAdjacentHTML('beforeend', `
        <div class="bank-modal" id="questionBankModal" aria-hidden="true">
            <section class="glass bank-modal__card" role="dialog" aria-modal="true" aria-labelledby="questionBankTitle">
                <div class="bank-modal__head">
                    <div>
                        <span class="builder-summary__label">Question Bank Controls</span>
                        <h2 id="questionBankTitle">Random question selection</h2>
                        <p class="mini">Choose how many questions each section gives to a student. Enter 0 to use every question.</p>
                    </div>
                    <button class="btn secondary btn-icon" type="button" id="questionBankClose" aria-label="Close question bank"><i class="ph-bold ph-x"></i></button>
                </div>
                <div class="bank-modal__list" id="questionBankList"></div>
                <div class="bank-modal__footer">
                    <button class="btn secondary" type="button" id="questionBankCancel">Cancel</button>
                    <button class="btn primary" type="button" id="questionBankApply"><i class="ph-bold ph-check"></i>Apply Settings</button>
                </div>
            </section>
        </div>`);

    const modal = $('questionBankModal');
    const close = () => {
        modal.classList.remove('show');
        modal.setAttribute('aria-hidden', 'true');
    };
    $('questionBankClose').onclick = close;
    $('questionBankCancel').onclick = close;
    modal.onclick = event => { if (event.target === modal) close(); };
    $('questionBankApply').onclick = () => {
        questionBankDraft.forEach(draft => {
            const section = sections.find(item => item.id === draft.id);
            if (!section) return;
            section.pickCount = draft.pickCount > 0 && draft.pickCount < draft.bankCount ? draft.pickCount : 0;
            section.shuffleQuestions = !!draft.shuffleQuestions;
            section.shuffleChoices = !!draft.shuffleChoices;
        });
        close();
        renderQ();
        scheduleAutosave();
        toast('Question bank settings applied.');
    };
}

function renderQuestionBankModal(focusSectionId = '') {
    const list = $('questionBankList');
    if (!list) return;
    list.innerHTML = questionBankDraft.map((draft, index) => `
        <article class="bank-row ${draft.id === focusSectionId ? 'is-focus' : ''}" data-bank-row="${esc(draft.id)}">
            <div class="bank-row__identity">
                <span class="section-badge">${index + 1}</span>
                <div><strong>${esc(draft.title)}</strong><p class="mini">${draft.bankCount} question${draft.bankCount === 1 ? '' : 's'} available</p></div>
            </div>
            <div class="bank-row__controls">
                <label class="bank-pick"><span>Random pick</span><input type="number" min="0" max="${draft.bankCount}" value="${draft.pickCount}" data-bank-pick="${esc(draft.id)}"><small>0 = all</small></label>
                <label class="section-toggle"><input type="checkbox" data-bank-shuffleq="${esc(draft.id)}" ${draft.shuffleQuestions ? 'checked' : ''}><span>Shuffle questions</span></label>
                <label class="section-toggle"><input type="checkbox" data-bank-shufflec="${esc(draft.id)}" ${draft.shuffleChoices ? 'checked' : ''}><span>Shuffle choices</span></label>
                <button class="btn secondary btn-sm" type="button" data-bank-all="${esc(draft.id)}">Use all</button>
            </div>
        </article>`).join('');

    list.oninput = event => {
        const target = event.target;
        if (!target.matches('[data-bank-pick]')) return;
        const draft = questionBankDraft.find(item => item.id === target.dataset.bankPick);
        if (!draft) return;
        const value = Math.max(0, Math.floor(Number(target.value) || 0));
        draft.pickCount = value > 0 ? Math.min(value, draft.bankCount) : 0;
        if (Number(target.value) > draft.bankCount) target.value = String(draft.bankCount);
    };
    list.onchange = event => {
        const target = event.target;
        if (target.matches('[data-bank-shuffleq]')) {
            const draft = questionBankDraft.find(item => item.id === target.dataset.bankShuffleq);
            if (draft) draft.shuffleQuestions = target.checked;
        }
        if (target.matches('[data-bank-shufflec]')) {
            const draft = questionBankDraft.find(item => item.id === target.dataset.bankShufflec);
            if (draft) draft.shuffleChoices = target.checked;
        }
    };
    list.onclick = event => {
        const button = event.target.closest('[data-bank-all]');
        if (!button) return;
        const draft = questionBankDraft.find(item => item.id === button.dataset.bankAll);
        if (!draft) return;
        draft.pickCount = 0;
        renderQuestionBankModal(focusSectionId);
    };
}

function openQuestionBank(sectionId = '') {
    ensureQuestionBankModal();
    questionBankDraft = sections.map(section => {
        const bankCount = questions.filter(question => question.sectionId === section.id).length;
        const requested = Math.max(0, Math.floor(Number(section.pickCount || 0)));
        return {
            id: section.id,
            title: section.title,
            bankCount,
            pickCount: requested > 0 && requested < bankCount ? requested : 0,
            shuffleQuestions: !!section.shuffleQuestions,
            shuffleChoices: !!section.shuffleChoices
        };
    });
    renderQuestionBankModal(sectionId);
    const modal = $('questionBankModal');
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
        const row = sectionId ? [...modal.querySelectorAll('[data-bank-row]')].find(item => item.dataset.bankRow === sectionId) : null;
        row?.scrollIntoView({ block: 'center' });
        row?.querySelector('input')?.focus();
    });
}

function securityToggle(id, title, description, checked = false) {
    return `<label class="security-toggle-card"><input id="${id}" type="checkbox" ${checked ? 'checked' : ''}><span><b>${title}</b><small>${description}</small></span></label>`;
}

function ensureSecuritySettingsUi() {
    if ($('securitySettingsCard')) return;
    const grid = $('form')?.querySelector('.form-grid');
    if (!grid) return;
    if (!$('assessmentSecurityStyles')) {
        document.head.insertAdjacentHTML('beforeend', `<style id="assessmentSecurityStyles">
            .security-settings-shell{border:1px solid rgba(100,116,139,.17);border-radius:20px;background:rgba(255,255,255,.38);overflow:hidden}.security-settings-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;padding:18px 20px;border-bottom:1px solid rgba(100,116,139,.14);background:linear-gradient(135deg,rgba(0,61,165,.07),rgba(15,159,110,.04))}.security-settings-head h3{font-size:16px;margin:2px 0 4px}.security-settings-head p{font-size:11px;color:var(--text-muted);font-weight:700;max-width:650px;line-height:1.55}.security-mode-field{min-width:230px}.security-mode-field label{font-size:10px;margin-bottom:5px}.security-mode-note{padding:10px 20px;background:var(--accent-light);font-size:11px;color:var(--text-muted);font-weight:700;line-height:1.55}.security-group{border-top:1px solid rgba(100,116,139,.13)}.security-group summary{display:flex;align-items:center;gap:9px;padding:14px 20px;cursor:pointer;font-size:12px;font-weight:900;color:var(--text-main);list-style:none}.security-group summary::-webkit-details-marker{display:none}.security-group summary:after{content:'+';margin-left:auto;font-size:17px;color:var(--text-muted)}.security-group[open] summary:after{content:'−'}.security-group-body{padding:0 20px 18px}.security-control-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:10px}.security-toggle-card{display:flex!important;align-items:flex-start;gap:10px;padding:12px!important;border-radius:14px;background:var(--accent-light);border:1px solid rgba(100,116,139,.12);color:var(--text-main)!important;font-size:12px!important;font-weight:800!important;text-transform:none!important;letter-spacing:0!important;cursor:pointer}.security-toggle-card input{margin-top:2px;accent-color:var(--accent-primary);width:16px;height:16px}.security-toggle-card span{display:grid;gap:3px}.security-toggle-card small{font-size:10px;color:var(--text-muted);font-weight:700;line-height:1.45}.security-number-card{padding:12px;border-radius:14px;background:var(--accent-light);border:1px solid rgba(100,116,139,.12)}.security-number-card label{font-size:10px;margin-bottom:6px}.security-number-card small{display:block;margin-top:5px;color:var(--text-muted);font-size:10px;font-weight:700;line-height:1.4}.security-provider-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-top:10px}.security-integration-note{margin-top:10px;padding:11px 12px;border-radius:13px;background:rgba(245,158,11,.09);border:1px solid rgba(245,158,11,.2);color:#9a6500;font-size:10px;font-weight:750;line-height:1.5}.security-policy-scroll{overflow:auto;border:1px solid rgba(100,116,139,.14);border-radius:15px}.security-policy-table{width:100%;min-width:1050px;border-collapse:collapse;font-size:10px}.security-policy-table th,.security-policy-table td{padding:9px 8px;border-bottom:1px solid rgba(100,116,139,.11);text-align:left;vertical-align:middle}.security-policy-table th{position:sticky;top:0;background:var(--bg-body);z-index:1;color:var(--text-muted);font-size:8px;text-transform:uppercase;letter-spacing:.45px}.security-policy-table td:first-child{min-width:190px}.security-policy-table .select,.security-policy-table .input{height:34px!important;padding:6px 8px!important;border-radius:9px!important;font-size:9px!important}.security-policy-check{display:flex;justify-content:center}.security-policy-check input{width:15px;height:15px;accent-color:var(--accent-primary)}.security-policy-help{margin-bottom:10px;color:var(--text-muted);font-size:10px;font-weight:700;line-height:1.5}@media(max-width:720px){.security-settings-head{flex-direction:column}.security-mode-field{width:100%;min-width:0}.security-settings-head,.security-group-body{padding-left:14px;padding-right:14px}.security-group summary{padding-left:14px;padding-right:14px}}
        </style>`);
    }
    grid.insertAdjacentHTML('beforeend', `
        <div class="field full" id="securitySettingsCard">
            <label>Security and Monitoring</label>
            <section class="security-settings-shell">
                <header class="security-settings-head">
                    <div><span class="assessment-library-kicker">Assessment protection</span><h3>Security and Monitoring</h3><p>Choose a mode, then adjust only the controls your class needs. Settings affect real student and server behavior.</p></div>
                    <div class="security-mode-field"><label for="securityMode">Security mode</label><select class="select" id="securityMode"><option value="standard">Standard</option><option value="monitored">Monitored</option><option value="strict">Strict</option><option value="secure_browser_ready">Secure Browser Ready</option></select></div>
                </header>
                <div class="security-mode-note" id="securityModeDescription"></div>
                <details class="security-group" open><summary><i class="ph-fill ph-sliders-horizontal"></i>Basic exam controls</summary><div class="security-group-body"><div class="security-control-grid">
                    ${securityToggle('securityFullscreen','Require fullscreen','Pause the assessment when required fullscreen is exited.')}
                    ${securityToggle('securityBacktracking','Allow question backtracking','Students may return to earlier questions.')}
                    ${securityToggle('securityOneQuestionPage','One question per page','Show one focused question at a time.', true)}
                    ${securityToggle('securityShowNavigator','Show question navigator','Display question numbers and answered status.', true)}
                    ${securityToggle('securityResumeRefresh','Allow resume after refresh','Restore the same attempt and stable questions after a permitted refresh.', true)}
                    ${securityToggle('securityResumeConnection','Allow resume after connection loss','Keep saved answers and reconnect within the grace period.', true)}
                    <div class="security-number-card"><label for="securityMaxAttempts">Maximum attempts</label><input class="input" id="securityMaxAttempts" type="number" min="1" max="20" value="1"><small>Additional attempts require an explicit value above 1.</small></div>
                    <div class="security-number-card"><label for="securityGraceSeconds">Connection grace period (seconds)</label><input class="input" id="securityGraceSeconds" type="number" min="5" max="600" value="60"><small>Brief interruptions are not automatically treated as cheating.</small></div>
                    <div class="security-number-card"><label for="securityMaxSessions">Maximum simultaneous sessions</label><input class="input" id="securityMaxSessions" type="number" min="1" max="5" value="1"><small>One session is recommended for normal exams.</small></div>
                </div></div></details>
                <details class="security-group" open><summary><i class="ph-fill ph-warning-circle"></i>Warnings and responses</summary><div class="security-group-body"><div class="security-control-grid">
                    <div class="security-number-card"><label for="securityMaxViolations">Warning limit</label><input class="input" id="securityMaxViolations" type="number" min="1" max="100" value="5"><small>Weighted warning score allowed before the configured final response.</small></div>
                    <div class="security-number-card"><label for="securityFinalWarning">Final-warning threshold</label><input class="input" id="securityFinalWarning" type="number" min="0" max="100" value="4"><small>Shows a stronger warning before the final limit.</small></div>
                    <div class="security-number-card"><label for="securityPauseAfter">Pause after warning score</label><input class="input" id="securityPauseAfter" type="number" min="0" max="100" value="0"><small>Use 0 to pause only for selected high-risk events.</small></div>
                    <div class="security-number-card"><label for="securityWarningCalculation">Warning calculation</label><select class="select" id="securityWarningCalculation"><option value="weighted">Weighted by severity</option><option value="count">Count each warning event</option></select><small>Weighted scoring treats low and critical events differently.</small></div>
                    ${securityToggle('securityAutoSubmit','Auto-submit at final limit','Server finalizes the latest saved answers when the configured rule is reached.')}
                    ${securityToggle('securityHighRiskOnly','Auto-submit only for high-risk events','Low-severity events cannot trigger automatic submission by themselves.', true)}
                    ${securityToggle('securityAdminReview','Require administrator review instead','Pause and flag the attempt rather than auto-submitting.', true)}
                    ${securityToggle('securityResetWarningOnRecovery','Reset warnings on approved recovery','When an administrator approves a recovery, the server may reset the attempt warning score.')}
                </div></div></details>
                <details class="security-group"><summary><i class="ph-fill ph-eye"></i>Monitoring controls</summary><div class="security-group-body"><div class="security-control-grid">
                    ${securityToggle('monitorTabSwitch','Tab or app switching','Record grouped page-visibility changes.')}
                    ${securityToggle('monitorWindowFocus','Window focus changes','Record focus loss when it is not part of a grouped tab switch.')}
                    ${securityToggle('monitorFullscreen','Fullscreen exits','Record required fullscreen exits.')}
                    ${securityToggle('monitorClipboard','Copy, cut, and paste','Block and record clipboard actions.')}
                    ${securityToggle('monitorContextMenu','Right-click menu','Block and record the context menu.')}
                    ${securityToggle('monitorDragDrop','Drag and drop','Block external drag-and-drop into the exam.')}
                    ${securityToggle('monitorPrint','Printing','Record print requests.')}
                    ${securityToggle('monitorShortcuts','Restricted shortcuts','Block configured browser and developer shortcuts.')}
                    ${securityToggle('monitorNavigation','Browser navigation','Block and record back navigation.')}
                    ${securityToggle('monitorConnection','Connection state','Track offline duration and synchronization.', true)}
                    ${securityToggle('monitorDuplicateSession','Duplicate sessions','Prevent conflicting tabs, windows, or devices.', true)}
                </div></div></details>
                <details class="security-group"><summary><i class="ph-fill ph-list-checks"></i>Advanced event policies</summary><div class="security-group-body"><p class="security-policy-help">Fine-tune how each event is handled. Keep the defaults unless your assessment policy requires a different severity, warning weight, pause action, cooldown, or tolerated count.</p><div id="securityPolicyEditor"></div></div></details>
                <details class="security-group"><summary><i class="ph-fill ph-video-camera"></i>Optional device checks</summary><div class="security-group-body"><div class="security-control-grid">
                    ${securityToggle('securityCameraRequired','Require camera availability','Check that a camera stream remains available. No video is recorded or uploaded.')}
                    ${securityToggle('securityMicrophoneRequired','Require microphone availability','Check that a microphone stream remains available. No audio is recorded or uploaded.')}
                    ${securityToggle('securityScreenRequired','Require screen sharing','Require an active browser screen-share track. The portal does not record the stream.')}
                </div><p class="mini" style="margin-top:10px">Enable these only with an appropriate privacy notice and institutional policy.</p></div></details>
                <details class="security-group"><summary><i class="ph-fill ph-browser"></i>Secure browser integration</summary><div class="security-group-body">
                    <div class="security-control-grid">${securityToggle('securitySecureBrowserRequired','Require verified secure browser','Block exam start unless the configured backend verifier succeeds.')}${securityToggle('securitySecureBrowserVerification','Enable verification hook','Use the protected Cloudflare verification service when configured.')}</div>
                    <div class="security-provider-grid"><div class="security-number-card"><label for="securitySecureBrowserProvider">Provider</label><select class="select" id="securitySecureBrowserProvider"><option value="none">Not configured</option><option value="safe_exam_browser">Safe Exam Browser</option><option value="approved_provider">Other approved provider</option></select></div><div class="security-number-card"><label for="securitySecureBrowserConfigId">Public configuration ID</label><input class="input" id="securitySecureBrowserConfigId" maxlength="120" placeholder="Example: plv-midterm-2026"><small>Do not enter private Browser Exam Keys or signing secrets.</small></div></div>
                    <div class="security-integration-note"><i class="ph-fill ph-info"></i> Secure-browser verification remains unavailable until a real backend verification endpoint and protected credentials are configured. The portal never relies only on the user-agent string.</div>
                </div></details>
            </section>
        </div>`);
    const ids = [
        'securityMode','securityFullscreen','securityBacktracking','securityOneQuestionPage','securityShowNavigator','securityResumeRefresh','securityResumeConnection','securityMaxAttempts','securityGraceSeconds','securityMaxSessions','securityMaxViolations','securityFinalWarning','securityPauseAfter','securityWarningCalculation','securityAutoSubmit','securityHighRiskOnly','securityAdminReview','securityResetWarningOnRecovery','monitorTabSwitch','monitorWindowFocus','monitorFullscreen','monitorClipboard','monitorContextMenu','monitorDragDrop','monitorPrint','monitorShortcuts','monitorNavigation','monitorConnection','monitorDuplicateSession','securityCameraRequired','securityMicrophoneRequired','securityScreenRequired','securitySecureBrowserRequired','securitySecureBrowserVerification','securitySecureBrowserProvider','securitySecureBrowserConfigId'
    ];
    ids.forEach(id => {
        $(id)?.addEventListener('input', scheduleAutosave);
        $(id)?.addEventListener('change', scheduleAutosave);
    });
    $('securityPolicyEditor')?.addEventListener('input', scheduleAutosave);
    $('securityPolicyEditor')?.addEventListener('change', scheduleAutosave);
    $('securityMode').addEventListener('change', event => {
        applySecuritySettings({ security: MODE_DEFAULTS[event.target.value] || MODE_DEFAULTS.standard }, { preserveMode: false });
        scheduleAutosave();
    });
    applySecuritySettings({ security: MODE_DEFAULTS.standard });
}

function renderSecurityPolicyEditor(policies = {}) {
    const host = $('securityPolicyEditor');
    if (!host) return;
    host.innerHTML = `<div class="security-policy-scroll"><table class="security-policy-table"><thead><tr><th>Event</th><th>Enabled</th><th>Severity</th><th>Counts</th><th>Weight</th><th>Pause</th><th>Restore FS</th><th>May submit</th><th>Cooldown sec</th><th>Max count</th></tr></thead><tbody>${INCIDENT_CODES.map(code => {
        const policy = policies[code] || {};
        return `<tr data-policy-code="${esc(code)}"><td><b>${esc(incidentLabel(code))}</b><small style="display:block;color:var(--text-muted);margin-top:2px">${esc(code)}</small></td><td><label class="security-policy-check"><input data-policy-field="enabled" type="checkbox" ${policy.enabled !== false ? 'checked' : ''}></label></td><td><select class="select" data-policy-field="severity">${['info','low','medium','high','critical'].map(value => `<option value="${value}" ${policy.severity===value?'selected':''}>${value}</option>`).join('')}</select></td><td><label class="security-policy-check"><input data-policy-field="countsWarning" type="checkbox" ${policy.countsWarning ? 'checked' : ''}></label></td><td><input class="input" data-policy-field="warningWeight" type="number" min="0" max="20" step="0.5" value="${Number(policy.warningWeight || 0)}"></td><td><label class="security-policy-check"><input data-policy-field="pausesExam" type="checkbox" ${policy.pausesExam ? 'checked' : ''}></label></td><td><label class="security-policy-check"><input data-policy-field="requireFullscreenRestore" type="checkbox" ${policy.requireFullscreenRestore ? 'checked' : ''}></label></td><td><label class="security-policy-check"><input data-policy-field="mayAutoSubmit" type="checkbox" ${policy.mayAutoSubmit !== false ? 'checked' : ''}></label></td><td><input class="input" data-policy-field="cooldownSeconds" type="number" min="0" max="300" step="1" value="${Math.round(Number(policy.cooldownMs || 0)/1000)}"></td><td><input class="input" data-policy-field="maxToleratedCount" type="number" min="0" max="1000" step="1" value="${Number(policy.maxToleratedCount || 0)}"></td></tr>`;
    }).join('')}</tbody></table></div>`;
}

function collectEventPolicies() {
    const policies = {};
    document.querySelectorAll('#securityPolicyEditor [data-policy-code]').forEach(row => {
        const code = row.dataset.policyCode;
        const read = field => row.querySelector(`[data-policy-field="${field}"]`);
        policies[code] = {
            enabled: read('enabled')?.checked !== false,
            severity: read('severity')?.value || 'low',
            countsWarning: read('countsWarning')?.checked === true,
            warningWeight: Number(read('warningWeight')?.value || 0),
            pausesExam: read('pausesExam')?.checked === true,
            requireFullscreenRestore: read('requireFullscreenRestore')?.checked === true,
            mayAutoSubmit: read('mayAutoSubmit')?.checked !== false,
            cooldownMs: Math.max(0, Number(read('cooldownSeconds')?.value || 0) * 1000),
            maxToleratedCount: Math.max(0, Math.floor(Number(read('maxToleratedCount')?.value || 0)))
        };
    });
    return policies;
}

function securityModeDescription(mode) {
    return {
        standard: 'Server-controlled timing, one active attempt, autosaving, randomized questions, and server-side scoring without aggressive browser monitoring.',
        monitored: 'Standard protections plus configurable tab, focus, clipboard, navigation, print, connection, and duplicate-session monitoring.',
        strict: 'Monitored protections with required fullscreen, stronger warning responses, and optional automatic submission.',
        secure_browser_ready: 'Strict protections plus a backend-ready boundary for an approved secure browser. Real verification credentials are required before students can start.'
    }[mode] || '';
}

function applySecuritySettings(settings = {}, options = {}) {
    ensureSecuritySettingsUi();
    const config = normalizeSecurityConfig(settings?.security || settings || {});
    const setChecked = (id, value) => { if ($(id)) $(id).checked = !!value; };
    const setValue = (id, value) => { if ($(id)) $(id).value = value ?? ''; };
    setValue('securityMode', config.mode);
    setChecked('securityFullscreen', config.requireFullscreen);
    setChecked('securityBacktracking', config.allowBacktracking);
    setChecked('securityOneQuestionPage', config.oneQuestionPerPage);
    setChecked('securityShowNavigator', config.showNavigator);
    setChecked('securityResumeRefresh', config.allowResumeAfterRefresh);
    setChecked('securityResumeConnection', config.allowResumeAfterConnectionLoss);
    setValue('securityMaxAttempts', config.maxAttempts);
    setValue('securityGraceSeconds', config.connectionGraceSeconds);
    setValue('securityMaxSessions', config.maxSimultaneousSessions);
    setValue('securityMaxViolations', config.warningLimit);
    setValue('securityFinalWarning', config.finalWarningThreshold);
    setValue('securityPauseAfter', config.pauseAfterWarningCount);
    setValue('securityWarningCalculation', config.warningCalculation);
    setChecked('securityAutoSubmit', config.autoSubmitAfterFinalViolation);
    setChecked('securityHighRiskOnly', config.autoSubmitHighRiskOnly);
    setChecked('securityAdminReview', config.adminReviewInsteadOfAutoSubmit);
    setChecked('securityResetWarningOnRecovery', config.resetWarningOnApprovedResume);
    const m = config.monitoring || {};
    setChecked('monitorTabSwitch', m.tabSwitch); setChecked('monitorWindowFocus', m.windowFocus); setChecked('monitorFullscreen', m.fullscreenExit);
    setChecked('monitorClipboard', m.clipboard); setChecked('monitorContextMenu', m.contextMenu); setChecked('monitorDragDrop', m.dragDrop);
    setChecked('monitorPrint', m.print); setChecked('monitorShortcuts', m.restrictedShortcut); setChecked('monitorNavigation', m.browserNavigation);
    setChecked('monitorConnection', m.connection); setChecked('monitorDuplicateSession', m.duplicateSession);
    const media = config.media || {};
    setChecked('securityCameraRequired', media.cameraRequired); setChecked('securityMicrophoneRequired', media.microphoneRequired); setChecked('securityScreenRequired', media.screenShareRequired);
    setChecked('securitySecureBrowserRequired', config.requireSecureBrowser); setChecked('securitySecureBrowserVerification', config.secureBrowserVerificationEnabled);
    setValue('securitySecureBrowserProvider', config.secureBrowserProvider || 'none'); setValue('securitySecureBrowserConfigId', config.secureBrowserConfigId || '');
    renderSecurityPolicyEditor(config.eventPolicies || {});
    if ($('securityModeDescription')) $('securityModeDescription').textContent = securityModeDescription(config.mode);
    if (options.preserveMode === false && $('securityMode')) $('securityMode').value = config.mode;
}

function collectSecuritySettings() {
    ensureSecuritySettingsUi();
    return normalizeSecurityConfig({
        mode: $('securityMode')?.value || 'standard',
        requireFullscreen: $('securityFullscreen')?.checked === true,
        maxAttempts: Number($('securityMaxAttempts')?.value || 1),
        allowBacktracking: $('securityBacktracking')?.checked !== false,
        oneQuestionPerPage: $('securityOneQuestionPage')?.checked !== false,
        showNavigator: $('securityShowNavigator')?.checked !== false,
        allowResumeAfterRefresh: $('securityResumeRefresh')?.checked !== false,
        allowResumeAfterConnectionLoss: $('securityResumeConnection')?.checked !== false,
        connectionGraceSeconds: Number($('securityGraceSeconds')?.value || 60),
        maxSimultaneousSessions: Number($('securityMaxSessions')?.value || 1),
        warningLimit: Number($('securityMaxViolations')?.value || 5),
        finalWarningThreshold: Number($('securityFinalWarning')?.value || 4),
        pauseAfterWarningCount: Number($('securityPauseAfter')?.value || 0),
        warningCalculation: $('securityWarningCalculation')?.value || 'weighted',
        autoSubmitAfterFinalViolation: $('securityAutoSubmit')?.checked === true,
        autoSubmitHighRiskOnly: $('securityHighRiskOnly')?.checked !== false,
        adminReviewInsteadOfAutoSubmit: $('securityAdminReview')?.checked === true,
        resetWarningOnApprovedResume: $('securityResetWarningOnRecovery')?.checked === true,
        monitoring: {
            tabSwitch: $('monitorTabSwitch')?.checked === true, windowFocus: $('monitorWindowFocus')?.checked === true,
            fullscreenExit: $('monitorFullscreen')?.checked === true, clipboard: $('monitorClipboard')?.checked === true,
            contextMenu: $('monitorContextMenu')?.checked === true, dragDrop: $('monitorDragDrop')?.checked === true,
            print: $('monitorPrint')?.checked === true, restrictedShortcut: $('monitorShortcuts')?.checked === true,
            browserNavigation: $('monitorNavigation')?.checked === true, connection: $('monitorConnection')?.checked !== false,
            duplicateSession: $('monitorDuplicateSession')?.checked !== false,
            cameraState: $('securityCameraRequired')?.checked === true, microphoneState: $('securityMicrophoneRequired')?.checked === true,
            screenSharing: $('securityScreenRequired')?.checked === true, secureBrowserVerification: $('securitySecureBrowserVerification')?.checked === true
        },
        media: { cameraRequired: $('securityCameraRequired')?.checked === true, microphoneRequired: $('securityMicrophoneRequired')?.checked === true, screenShareRequired: $('securityScreenRequired')?.checked === true },
        requireSecureBrowser: $('securitySecureBrowserRequired')?.checked === true,
        secureBrowserProvider: $('securitySecureBrowserProvider')?.value || 'none',
        secureBrowserConfigId: $('securitySecureBrowserConfigId')?.value || '',
        secureBrowserVerificationEnabled: $('securitySecureBrowserVerification')?.checked === true,
        eventPolicies: collectEventPolicies()
    });
}

function ensureBuilderUi() {
    ensureSecuritySettingsUi();
    if (!$('qSection') && $('qPoints')) {
        $('qPoints').closest('.field')?.insertAdjacentHTML('afterend', `<div class="field"><label>Section</label><select class="select" id="qSection"></select></div>`);
    }
    renderSectionSelect();
    renderChoiceEditor();
    updateAnswerKeyUi();
    setupSmartPasteUi();
    setupGuidedQuestionBuilder();
    ensureQuestionBankModal();
}

function assessmentPageUrl(workspace = 'tests', idValue = '', isNew = false) {
    const url = new URL(location.href);
    url.searchParams.delete('standalone');
    url.searchParams.delete('workspace');
    url.searchParams.delete('id');
    url.searchParams.delete('new');
    if (workspace && workspace !== 'tests') url.searchParams.set('workspace', workspace);
    if (idValue) url.searchParams.set('id', idValue);
    if (isNew) url.searchParams.set('new', '1');
    return url;
}

function syncAssessmentHistory(workspace = 'tests', idValue = '', isNew = false, replace = false) {
    const url = assessmentPageUrl(workspace, idValue, isNew);
    const state = { workspace, id: idValue || '', isNew: Boolean(isNew) };
    if (!replace && url.href === location.href) return;
    history[replace ? 'replaceState' : 'pushState'](state, '', url);
}

async function navigateAssessment(workspace = 'tests', idValue = '', options = {}) {
    const { isNew = false, replace = false, updateHistory = true, focusTitle = false } = options;
    if (isNew) {
        reset();
        showWorkspace('details');
        if (updateHistory) syncAssessmentHistory('details', '', true, replace);
        if (focusTitle) setTimeout(() => $('title')?.focus(), 80);
        window.scrollTo({ top: 0, behavior: 'auto' });
        return true;
    }

    if (idValue && (idValue !== editing || !questions.length)) {
        const loaded = await edit(idValue, workspace);
        if (!loaded) return false;
    } else {
        showWorkspace(workspace);
    }

    if (updateHistory) {
        const historyId = workspace === 'tests' ? '' : (idValue || editing || '');
        syncAssessmentHistory(workspace, historyId, false, replace);
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
    return true;
}

function broadcastAssessmentChange(type = 'updated', idValue = editing || '') {
    const payload = { type, id: idValue, at: Date.now() };
    adminChannel?.postMessage(payload);
    localStorage.setItem('plvAdminAssessmentChange', JSON.stringify(payload));
}

function setupStandaloneShell() {
    if (!standaloneMode) return;
    document.body.classList.add('assessment-standalone');
    document.head.insertAdjacentHTML('beforeend', `<style>
        body.assessment-standalone{display:block;min-height:100vh}
        body.assessment-standalone .sidebar,body.assessment-standalone .mobile-nav-bar,body.assessment-standalone .assessment-workspace-tabs,body.assessment-standalone .main-wrapper>.header{display:none!important}
        body.assessment-standalone .main-wrapper{width:100%;max-width:none;padding:20px clamp(16px,3vw,42px) 40px;overflow:visible}
        body.assessment-standalone .assessment-grid[data-workspace="details"],body.assessment-standalone .assessment-grid[data-workspace="details"].builder-mode{max-width:1220px;margin:0 auto}
        body.assessment-standalone .standalone-assessment-bar{position:sticky;top:0;z-index:300;margin:-20px -20px 22px;padding:13px clamp(16px,3vw,42px);display:flex;align-items:center;justify-content:space-between;gap:14px;background:var(--glass-bg);backdrop-filter:blur(24px);border-bottom:1px solid var(--glass-border);box-shadow:0 10px 30px rgba(15,23,42,.08)}
        body.assessment-standalone .standalone-assessment-bar__title{display:flex;align-items:center;gap:12px;min-width:0}
        body.assessment-standalone .standalone-assessment-bar__icon{width:42px;height:42px;border-radius:14px;background:var(--accent-light);color:var(--accent-primary);display:flex;align-items:center;justify-content:center;font-size:22px;flex:0 0 auto}
        body.assessment-standalone .standalone-assessment-bar h1{font-size:17px;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        body.assessment-standalone .standalone-assessment-bar p{font-size:11px;color:var(--text-muted);font-weight:700;margin-top:2px}
        body.assessment-standalone .standalone-assessment-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        @media(max-width:650px){body.assessment-standalone .standalone-assessment-bar{align-items:flex-start;flex-direction:column}.standalone-assessment-actions{width:100%}.standalone-assessment-actions .btn{flex:1}}
    </style>`);
    const main = document.querySelector('.main-wrapper');
    main?.insertAdjacentHTML('afterbegin', `<div class="standalone-assessment-bar"><div class="standalone-assessment-bar__title"><div class="standalone-assessment-bar__icon"><i class="ph-fill ph-clipboard-text"></i></div><div><h1 id="standaloneTitle">Assessment Workspace</h1><p id="standaloneSub">Changes are saved to the same PLV Portal assessment record.</p></div></div><div class="standalone-assessment-actions"><button class="btn secondary" type="button" id="standaloneDetails"><i class="ph-bold ph-sliders-horizontal"></i> Details</button><button class="btn secondary" type="button" id="standaloneQuestions"><i class="ph-bold ph-list-checks"></i> Questions</button><button class="btn secondary" type="button" id="standaloneLibrary"><i class="ph-bold ph-stack"></i> Library</button><button class="btn secondary" type="button" id="standaloneTheme" aria-label="Change theme"><i class="ph-fill ph-sun"></i></button><button class="btn danger" type="button" id="standaloneClose"><i class="ph-bold ph-x"></i> Close</button></div></div>`);
    $('standaloneDetails').onclick = () => showWorkspace('details');
    $('standaloneQuestions').onclick = () => showWorkspace('builder');
    $('standaloneLibrary').onclick = () => {
        if (window.opener && !window.opener.closed) {
            window.opener.focus();
            window.close();
        } else location.href = 'admin-assessments.html';
    };
    $('standaloneClose').onclick = () => {
        window.close();
        setTimeout(() => location.href = 'admin-assessments.html', 200);
    };
    $('standaloneTheme').onclick = () => $('themeToggle')?.click();
}

function updateStandaloneTitle(workspace = requestedWorkspace) {
    if (!standaloneMode || !$('standaloneTitle')) return;
    const labels = {
        details: editing ? 'Edit Assessment Details' : 'Create New Assessment',
        builder: 'Questions Manager',
        results: 'Assessment Results',
        security: 'Assessment Anomaly Log',
        tests: 'Assessment Library'
    };
    $('standaloneTitle').textContent = labels[workspace] || 'Assessment Workspace';
    $('standaloneSub').textContent = editing
        ? `Assessment ID: ${editing} • autosave is enabled for question changes.`
        : 'Save the assessment details first, then continue to the Questions Manager.';
    if ($('standaloneQuestions')) {
        $('standaloneQuestions').disabled = !editing;
        $('standaloneQuestions').title = editing ? 'Open Questions Manager' : 'Save the assessment details first';
    }
    $('standaloneDetails')?.classList.toggle('primary', workspace === 'details');
    $('standaloneDetails')?.classList.toggle('secondary', workspace !== 'details');
    $('standaloneQuestions')?.classList.toggle('primary', workspace === 'builder');
    $('standaloneQuestions')?.classList.toggle('secondary', workspace !== 'builder');
}

function toast(message) {
    $('toast').textContent = message;
    $('toast').classList.add('show');
    setTimeout(() => $('toast').classList.remove('show'), 2600);
}

function setSaveIndicator(state = 'idle', message = '') {
    const indicator = $('assessmentSaveIndicator');
    if (!indicator) return;
    indicator.dataset.state = state;
    const defaults = {
        idle: editing ? 'All changes saved' : 'New assessment',
        pending: 'Unsaved changes',
        saving: 'Saving…',
        saved: 'All changes saved',
        blocked: 'Complete the required details to enable autosave',
        error: 'Autosave failed'
    };
    indicator.innerHTML = `<span class="assessment-save-dot"></span><span>${esc(message || defaults[state] || defaults.idle)}</span>`;
}

function updateAssessmentContext(workspace = currentWorkspace) {
    const contextBar = $('assessmentContextBar');
    if (contextBar) contextBar.hidden = workspace === 'tests';

    const titleValue = $('title')?.value?.trim();
    if ($('assessmentContextTitle')) {
        $('assessmentContextTitle').textContent = titleValue || (editing ? 'Untitled assessment' : 'Create a new assessment');
    }
    if ($('assessmentContextMode')) {
        const labels = {
            details: editing ? 'Assessment details' : 'New assessment',
            builder: 'Question builder',
            results: 'Student submissions',
            security: 'Anomaly log'
        };
        $('assessmentContextMode').textContent = labels[workspace] || 'Assessment workspace';
    }

    const detailsButton = document.querySelector('[data-assessment-view="details"]');
    const detailsLabel = $('detailsTabLabel');
    if (detailsLabel) detailsLabel.textContent = editing ? 'Details' : 'New Test';
    if (detailsButton) detailsButton.title = editing ? 'Edit assessment details' : 'Create a new assessment';

    const headerNew = $('headerNewAssessment');
    if (headerNew) headerNew.hidden = workspace !== 'tests';
    if (!document.activeElement?.matches('input, textarea, select')) setSaveIndicator('idle');
}

async function getToken() {
    const { data } = await supabase.auth.getSession();
    if (!data.session || !data.session.access_token) throw new Error('Please login again.');
    return data.session.access_token;
}

async function api(path, options = {}) {
    const response = await fetch('/api/assessments/' + path, {
        ...options,
        headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + await getToken(),
            ...(options.headers || {})
        }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Assessment request failed.');
    return data;
}

function iso(value) {
    return value ? new Date(value).toISOString() : null;
}

function theme() {
    if (localStorage.getItem('theme') === 'dark') document.body.classList.add('dark-theme');
    const setIcon = () => {
        const icon = $('themeIcon');
        if (icon) icon.className = document.body.classList.contains('dark-theme') ? 'ph-fill ph-moon' : 'ph-fill ph-sun';
    };
    setIcon();
    $('themeToggle').onclick = () => {
        document.body.classList.toggle('dark-theme');
        localStorage.setItem('theme', document.body.classList.contains('dark-theme') ? 'dark' : 'light');
        setIcon();
    };
}

function showWorkspace(name) {
    persistDraft();
    if ((name === 'builder' || name === 'results') && !editing) {
        toast(name === 'builder' ? 'Create or select a test first, then open Questions Manager.' : 'Select an assessment first to view results.');
        name = 'details';
    }
    currentWorkspace = name;
    const visible = name === 'builder' ? 'details' : (name === 'security' ? 'results' : name);
    document.querySelectorAll('[data-assessment-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.assessmentView === name));
    document.querySelectorAll('[data-workspace]').forEach(panel => {
        panel.style.display = panel.dataset.workspace === visible ? '' : 'none';
        if (panel.dataset.workspace === 'details') {
            panel.classList.toggle('builder-mode', name === 'builder');
            panel.classList.toggle('details-mode', name !== 'builder');
        }
    });
    if ($('resultsPanelTitle')) {
        $('resultsPanelTitle').hidden = name === 'security';
        if (name === 'results') $('resultsPanelTitle').textContent = 'Student Submissions';
    }
    if (name === 'results' && editing) attempts(editing);
    if (name === 'security') incidents();
    setBuilderLock();
    updateAssessmentContext(name);
    updateStandaloneTitle(name);
}

async function loadSelects() {
    const [subs, secs] = await Promise.all([
        supabase.from('subjects').select('*').order('subjectCode'),
        supabase.from('sections').select('*').order('sectionName')
    ]);
    $('subject').innerHTML = '<option value="">Select subject</option>' + (subs.data || []).map(s => `<option value="${esc(s.subjectCode)}">${esc(s.subjectCode)} - ${esc(s.subjectName || '')}</option>`).join('');
    $('section').innerHTML = '<option value="">Select section</option><option value="ALL">All Sections</option>' + (secs.data || []).map(s => `<option value="${esc(s.sectionName)}">${esc(s.sectionName)}</option>`).join('');
}

function setBuilderLock() {
    const builderButton = document.querySelector('[data-assessment-view="builder"]');
    const resultsButton = document.querySelector('[data-assessment-view="results"]');
    [builderButton, resultsButton].forEach(btn => {
        if (!btn) return;
        btn.disabled = !editing;
        btn.classList.toggle('locked', !editing);
    });
    if (builderButton) builderButton.title = editing ? 'Open Questions Manager' : 'Save the new test first';
    if (resultsButton) resultsButton.title = editing ? 'View student submissions' : 'Select or save an assessment first';
    updateAssessmentContext(currentWorkspace);
}

function draftPayload() {
    return { editing, assessment: currentAssessment(), sections: builderSettingsSnapshot(), questions, savedAt: new Date().toISOString() };
}

function autosaveSignature(assessment, questionList) {
    const { id, ...stableAssessment } = assessment;
    return JSON.stringify({ assessment: stableAssessment, sections: builderSettingsSnapshot(), questions: questionList });
}

function draftStore() {
    return standaloneMode ? sessionStorage : localStorage;
}

function persistDraft() {
    clearTimeout(draftPersistTimer);
    try {
        draftStore().setItem(DRAFT_KEY, JSON.stringify(draftPayload()));
    } catch (_) {}
}

function queueDraftPersist(delay = 260) {
    clearTimeout(draftPersistTimer);
    draftPersistTimer = setTimeout(persistDraft, delay);
}

function clearDraft() {
    clearTimeout(draftPersistTimer);
    draftStore().removeItem(DRAFT_KEY);
}

function restoreDraft() {
    try {
        const raw = draftStore().getItem(DRAFT_KEY);
        if (!raw || editing) return false;
        const draft = JSON.parse(raw);
        const assessment = draft.assessment || {};
        editing = draft.editing || null;
        sections = Array.isArray(draft.sections) && draft.sections.length ? draft.sections : (assessment.settings && Array.isArray(assessment.settings.builderSections) ? assessment.settings.builderSections : []);
        $('title').value = assessment.title || '';
        $('instructions').value = assessment.instructions || '';
        $('subject').value = assessment.subject_code || '';
        $('section').value = assessment.section || '';
        $('status').value = assessment.status || 'draft';
        $('duration').value = assessment.duration_minutes || 30;
        $('opensAt').value = assessment.opens_at ? String(assessment.opens_at).slice(0, 16) : '';
        $('closesAt').value = assessment.closes_at ? String(assessment.closes_at).slice(0, 16) : '';
        ensureSecuritySettingsUi();
        applySecuritySettings(assessment.settings || {});
        questions = Array.isArray(draft.questions) ? draft.questions : [];
        normalizeBuilderState();
        if (editing) lastAutosaveSignature = autosaveSignature(assessment, questions);
        ensureBuilderUi();
        renderQ();
        if (assessment.title && assessment.subject_code && assessment.section) scheduleAutosave();
        return true;
    } catch (_) {
        return false;
    }
}

async function runAutosave() {
    const assessment = currentAssessment();
    if (!assessment.title || !assessment.subject_code || !assessment.section) {
        setSaveIndicator('blocked');
        return false;
    }
    const signature = autosaveSignature(assessment, questions);
    if (signature === lastAutosaveSignature) {
        setSaveIndicator('saved');
        return true;
    }
    setSaveIndicator('saving');
    const data = await api('admin/save', { method: 'POST', body: JSON.stringify({ assessment, questions }) });
    const createdNewRecord = !editing;
    editing = data.id;
    assessment.id = data.id;
    if (createdNewRecord && currentWorkspace !== 'tests') syncAssessmentHistory(currentWorkspace, data.id, false, true);
    broadcastAssessmentChange('autosaved', data.id);
    lastAutosaveSignature = signature;
    persistDraft();
    setBuilderLock();
    updateAssessmentContext(currentWorkspace);
    updateStandaloneTitle(document.querySelector('[data-assessment-view].active')?.dataset.assessmentView || 'details');
    setSaveIndicator('saved');
    return true;
}

function scheduleAutosave() {
    setSaveIndicator('pending');
    queueDraftPersist();
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(async () => {
        try {
            await runAutosave();
        } catch (_) {
            setSaveIndicator('error');
        }
    }, 950);
}

function renderQ() {
    normalizeBuilderState();
    const totalPoints = questions.reduce((sum, question) => sum + Number(question.points || 0), 0);
    const totalQuestions = questions.length;
    const grouped = sections.map(section => ({
        section,
        items: questions.filter(question => question.sectionId === section.id).sort((a, b) => Number(a.order_no || 0) - Number(b.order_no || 0))
    }));
    $('qList').innerHTML = `
        <div class="builder-toolbar">
            <div class="builder-toolbar__title">
                <span class="builder-summary__label">Assessment outline</span>
                <strong>${$('title')?.value?.trim() || (editing ? 'Saved assessment' : 'New assessment')}</strong>
                <p class="mini">Rename sections, choose random question counts, and review all saved questions.</p>
            </div>
            <div class="builder-toolbar__actions">
                <button class="btn secondary" type="button" id="addSectionBtn"><i class="ph-bold ph-plus"></i>Add Section</button>
                <button class="btn secondary" type="button" id="questionReviewBtn"><i class="ph-bold ph-book-open-text"></i>Review Questions</button>
                <button class="btn secondary" type="button" id="questionBankBtn"><i class="ph-bold ph-browsers"></i>Question Bank</button>
                <button class="btn primary" type="button" id="saveAllBtn"><i class="ph-bold ph-floppy-disk"></i>Save All</button>
            </div>
        </div>
        <div class="builder-summary">
            <div><span class="builder-summary__label">Sections</span><strong>${sections.length}</strong></div>
            <div><span class="builder-summary__label">Questions ready</span><strong>${totalQuestions} item${totalQuestions === 1 ? '' : 's'}</strong></div>
            <div><span class="builder-summary__label">Total points</span><strong>${totalPoints}</strong></div>
        </div>
        ${grouped.length ? grouped.map((entry, index) => {
            const section = entry.section;
            const items = entry.items;
            const bankCount = items.length;
            const pickCount = Math.max(0, Number(section.pickCount || 0));
            const effectivePickCount = pickCount > 0 && pickCount < bankCount ? pickCount : 0;
            const bankLabel = effectivePickCount ? `Pick ${effectivePickCount} / ${bankCount} qs` : `${bankCount} qs`;
            return `
            <article class="section-card ${section.collapsed ? 'collapsed' : ''}" data-section-card="${esc(section.id)}">
                <div class="section-head">
                    <div class="section-identity">
                        <div class="section-badge">${toRoman(index + 1)}</div>
                        <div class="section-name-stack">
                            <span class="section-name-label">Section name · click to rename</span>
                            <div class="section-name-control">
                                <input class="section-title-input" data-section-title="${esc(section.id)}" value="${esc(section.title)}" placeholder="Example: Section I — Definitions" aria-label="Rename section">
                                <button class="section-rename-btn" type="button" data-section-rename="${esc(section.id)}" title="Rename section" aria-label="Rename ${esc(section.title)}"><i class="ph-bold ph-pencil-simple"></i></button>
                            </div>
                        </div>
                    </div>
                    <div class="section-head__controls">
                        <button class="section-bank" type="button" data-section-bank="${esc(section.id)}" title="Configure random selection">
                            <i class="ph-bold ph-stack-simple"></i><span>${effectivePickCount ? `Pick ${effectivePickCount} of ${bankCount}` : `Use all ${bankCount}`}</span>
                        </button>
                        <label class="section-toggle"><input type="checkbox" data-section-shuffleq="${esc(section.id)}" ${section.shuffleQuestions ? 'checked' : ''}><span>Shuffle questions</span></label>
                        <label class="section-toggle"><input type="checkbox" data-section-shufflec="${esc(section.id)}" ${section.shuffleChoices ? 'checked' : ''}><span>Shuffle choices</span></label>
                        <div class="section-icon-actions">
                            <button class="btn secondary btn-icon" type="button" data-section-toggle="${esc(section.id)}" title="${section.collapsed ? 'Expand' : 'Collapse'}"><i class="ph-bold ${section.collapsed ? 'ph-caret-down' : 'ph-caret-up'}"></i></button>
                            <button class="btn secondary btn-icon" type="button" data-section-up="${esc(section.id)}" title="Move section up" ${index === 0 ? 'disabled' : ''}><i class="ph-bold ph-arrow-up"></i></button>
                            <button class="btn secondary btn-icon" type="button" data-section-down="${esc(section.id)}" title="Move section down" ${index === sections.length - 1 ? 'disabled' : ''}><i class="ph-bold ph-arrow-down"></i></button>
                            <button class="btn secondary btn-icon" type="button" data-section-dup="${esc(section.id)}" title="Duplicate section"><i class="ph-bold ph-copy"></i></button>
                            <button class="btn danger btn-icon" type="button" data-section-del="${esc(section.id)}" title="Delete section"><i class="ph-bold ph-trash"></i></button>
                        </div>
                    </div>
                </div>
                <div class="section-head__sub">
                    <span class="mini">${bankLabel}</span>
                    <div class="section-add-menu">
                        <span class="section-add-label">Add:</span>
                        <button class="btn section-type-btn mc" type="button" data-add-q-type="multiple_choice" data-section-id="${esc(section.id)}"><i class="ph-bold ph-list-bullets"></i> Multiple Choice</button>
                        <button class="btn section-type-btn tf" type="button" data-add-q-type="true_false" data-section-id="${esc(section.id)}"><i class="ph-bold ph-check-square"></i> True/False</button>
                        <button class="btn section-type-btn id" type="button" data-add-q-type="short_answer" data-section-id="${esc(section.id)}"><i class="ph-bold ph-textbox"></i> Identification</button>
                        <button class="btn section-type-btn es" type="button" data-add-q-type="essay" data-section-id="${esc(section.id)}"><i class="ph-bold ph-article"></i> Essay</button>
                        <button class="btn secondary section-type-btn" type="button" data-smart-paste-section="${esc(section.id)}"><i class="ph-bold ph-clipboard-text"></i> Smart Paste</button>
                    </div>
                </div>
                <div class="section-body ${section.collapsed ? 'is-collapsed' : ''}">
                    ${items.length ? items.map((q, qIndex) => {
                        const typeLabel = q.type.replace('_', ' ');
                        const answerLabel = q.answer_key || 'Manual grading';
                        const choiceRows = q.choices.length ? q.choices.map((choice, choiceIndex) => `
                            <div class="question-choice-row ${answerLabel === choice ? 'is-correct' : ''}">
                                <span class="question-choice-key">${String.fromCharCode(65 + choiceIndex)}</span>
                                <span class="question-choice-text">${esc(choice)}</span>
                            </div>
                        `).join('') : '';
                        return `
                        <article class="question-card" data-question-card-id="${esc(q.id)}">
                            <div class="question-card__top">
                                <div>
                                    <div class="question-card__title">Question ${qIndex + 1}</div>
                                    <div class="question-card__meta">
                                        <span class="question-chip">${esc(typeLabel)}</span>
                                        <span class="question-chip question-chip--points">${Number(q.points || 0)} pts</span>
                                    </div>
                                </div>
                                <div class="question-actions">
                                    <button class="btn secondary btn-icon" data-moveup="${esc(q.id)}" data-section-id="${esc(section.id)}" type="button" aria-label="Move question up" ${qIndex === 0 ? 'disabled' : ''} title="Move up"><i class="ph-bold ph-caret-up"></i></button>
                                    <button class="btn secondary btn-icon" data-movedown="${esc(q.id)}" data-section-id="${esc(section.id)}" type="button" aria-label="Move question down" ${qIndex === items.length - 1 ? 'disabled' : ''} title="Move down"><i class="ph-bold ph-caret-down"></i></button>
                                    <button class="btn secondary btn-icon" data-dupq="${esc(q.id)}" data-section-id="${esc(section.id)}" type="button" aria-label="Duplicate question" title="Duplicate"><i class="ph-bold ph-copy"></i></button>
                                    <button class="btn danger btn-icon" data-delq="${esc(q.id)}" data-section-id="${esc(section.id)}" type="button" aria-label="Delete question" title="Delete"><i class="ph-bold ph-trash"></i></button>
                                </div>
                            </div>
                            <p class="question-card__prompt">${esc(q.prompt)}</p>
                            ${choiceRows ? `<div class="question-card__choices"><span>Choices</span><div class="question-choice-list">${choiceRows}</div></div>` : ''}
                            <div class="question-card__answer"><span>Answer key</span><strong>${esc(answerLabel)}</strong></div>
                        </article>`;
                    }).join('') : '<article class="question-card builder-empty"><b>No questions in this section yet.</b><p>Add items below, or use the Question Bank button to set a random pick count for this section.</p></article>'}
                </div>
            </article>`;
        }).join('') : '<article class="question-card builder-empty"><b>No sections yet.</b><p>Create a section to start building a question bank.</p></article>'}
        <div class="builder-footer"><button class="btn secondary" type="button" id="footerAddSectionBtn"><i class="ph-bold ph-plus"></i>Add another section</button></div>`;
    renderSectionSelect();
    bindBuilderEvents();
    if ($('questionReviewModal')?.classList.contains('show')) {
        renderQuestionReviewFilters();
        renderQuestionReviewList();
    }
}

function sectionQuestions(sectionId) {
    return questions.filter(question => question.sectionId === sectionId).sort((a, b) => Number(a.order_no || 0) - Number(b.order_no || 0));
}

function sortQuestionsBySection() {
    const sectionOrder = new Map(sections.map((section, index) => [section.id, index]));
    questions.sort((a, b) => {
        const sectionDiff = (sectionOrder.get(a.sectionId) ?? 999) - (sectionOrder.get(b.sectionId) ?? 999);
        if (sectionDiff !== 0) return sectionDiff;
        return Number(a.order_no || 0) - Number(b.order_no || 0);
    });
}

function renumberQuestions() {
    sortQuestionsBySection();
    questions.forEach((question, index) => { question.order_no = index + 1; });
}

function reorderWithinSection(sectionId, questionId, direction) {
    const items = sectionQuestions(sectionId);
    const currentIndex = items.findIndex(question => question.id === questionId);
    const targetIndex = currentIndex + direction;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= items.length) return;
    const [moved] = items.splice(currentIndex, 1);
    items.splice(targetIndex, 0, moved);
    const byId = new Map(items.map((question, index) => [question.id, index + 1]));
    questions.forEach(question => {
        if (question.sectionId === sectionId && byId.has(question.id)) question.order_no = byId.get(question.id);
    });
    questions.sort((a, b) => {
        if (a.sectionId === b.sectionId) return Number(a.order_no || 0) - Number(b.order_no || 0);
        const sectionOrder = sections.findIndex(section => section.id === a.sectionId) - sections.findIndex(section => section.id === b.sectionId);
        return sectionOrder;
    });
    renderQ();
    scheduleAutosave();
}

function duplicateQuestion(questionId) {
    const source = questions.find(question => question.id === questionId);
    if (!source) return;
    const clone = JSON.parse(JSON.stringify(source));
    clone.id = uid('q');
    clone.order_no = Number(source.order_no || 0) + 0.5;
    questions.push(clone);
    renumberQuestions();
    renderQ();
    scheduleAutosave();
}

function deleteQuestion(questionId) {
    questions = questions.filter(question => question.id !== questionId);
    renumberQuestions();
    renderQ();
    scheduleAutosave();
}

function addSection(title) {
    const section = createSection(title);
    sections.push(section);
    activeSectionId = section.id;
    renderQ();
    scheduleAutosave();
}

function updateSection(sectionId, patch, options = {}) {
    const section = sections.find(item => item.id === sectionId);
    if (!section) return;
    Object.assign(section, patch);
    if (options.render !== false) renderQ();
    scheduleAutosave();
}

function toggleSectionCollapsed(sectionId, button) {
    const section = sections.find(item => item.id === sectionId);
    if (!section) return;
    section.collapsed = !section.collapsed;
    const card = button?.closest('[data-section-card]') || document.querySelector(`[data-section-card="${CSS.escape(sectionId)}"]`);
    card?.classList.toggle('collapsed', section.collapsed);
    card?.querySelector('.section-body')?.classList.toggle('is-collapsed', section.collapsed);
    const icon = button?.querySelector('i');
    if (icon) icon.className = `ph-bold ${section.collapsed ? 'ph-caret-down' : 'ph-caret-up'}`;
    if (button) button.title = section.collapsed ? 'Expand' : 'Collapse';
    scheduleAutosave();
}

function duplicateSection(sectionId) {
    const index = sections.findIndex(section => section.id === sectionId);
    if (index < 0) return;
    const source = sections[index];
    const clone = { ...source, id: uid('sec'), title: `${source.title} Copy`, collapsed: false };
    sections.splice(index + 1, 0, clone);
    const clonedQuestions = sectionQuestions(sectionId).map(question => ({ ...JSON.parse(JSON.stringify(question)), id: uid('q'), sectionId: clone.id, order_no: Number(question.order_no || 1) }));
    questions.push(...clonedQuestions);
    renumberQuestions();
    activeSectionId = clone.id;
    renderQ();
    scheduleAutosave();
}

function deleteSection(sectionId) {
    if (sections.length === 1) return toast('Keep at least one section.');
    const section = sections.find(item => item.id === sectionId);
    const count = questions.filter(question => question.sectionId === sectionId).length;
    if (!confirm(`Delete "${section?.title || 'this section'}" and its ${count} question${count === 1 ? '' : 's'}?`)) return;
    sections = sections.filter(section => section.id !== sectionId);
    questions = questions.filter(question => question.sectionId !== sectionId);
    if (activeSectionId === sectionId) activeSectionId = sections[0].id;
    renumberQuestions();
    renderQ();
    scheduleAutosave();
}

function moveSection(sectionId, direction) {
    const index = sections.findIndex(section => section.id === sectionId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= sections.length) return;
    const [item] = sections.splice(index, 1);
    sections.splice(targetIndex, 0, item);
    renumberQuestions();
    renderQ();
    scheduleAutosave();
}

function addQuestionToSection(sectionId, type = '') {
    activeSectionId = sectionId;
    const select = $('qSection');
    const smartSelect = $('smartPasteSection');
    if (select) select.value = sectionId;
    if (smartSelect) smartSelect.value = sectionId;
    if (type) chooseGuidedQuestionType(type);
    else {
        closeGuidedQuestionEditor({ clear: false, scroll: true });
        setTimeout(() => $('questionTypeStep')?.classList.add('question-editor-flash'), 250);
    }
}

function applyQuestionBank(sectionId) {
    openQuestionBank(sectionId);
}

function bindBuilderEvents() {
    const list = $('qList');
    if (list) {
        list.onclick = event => {
            const target = event.target.closest('button');
            if (!target) return;
            if (target.id === 'addSectionBtn' || target.id === 'footerAddSectionBtn') return addSection();
            if (target.id === 'questionReviewBtn') return openQuestionReviewManager();
            if (target.id === 'questionBankBtn') {
                const section = sections.find(item => item.id === activeSectionId) || sections[0];
                if (!section) return;
                return applyQuestionBank(section.id);
            }
            if (target.id === 'saveAllBtn') return $('form').requestSubmit();
            if (target.dataset.sectionRename) {
                const input = target.closest('[data-section-card]')?.querySelector('[data-section-title]');
                input?.focus();
                input?.select();
                return;
            }
            if (target.dataset.smartPasteSection) return openSmartPasteForSection(target.dataset.smartPasteSection);
            if (target.dataset.addQType) return addQuestionToSection(target.dataset.sectionId, target.dataset.addQType);
            if (target.dataset.addQSection) return addQuestionToSection(target.dataset.addQSection);
            if (target.dataset.sectionBank) return applyQuestionBank(target.dataset.sectionBank);
            if (target.dataset.sectionToggle) return toggleSectionCollapsed(target.dataset.sectionToggle, target);
            if (target.dataset.sectionDup) return duplicateSection(target.dataset.sectionDup);
            if (target.dataset.sectionDel) return deleteSection(target.dataset.sectionDel);
            if (target.dataset.sectionUp) return moveSection(target.dataset.sectionUp, -1);
            if (target.dataset.sectionDown) return moveSection(target.dataset.sectionDown, 1);
            if (target.dataset.delq) return deleteQuestion(target.dataset.delq);
            if (target.dataset.dupq) return duplicateQuestion(target.dataset.dupq);
            if (target.dataset.moveup) return reorderWithinSection(target.dataset.sectionId, target.dataset.moveup, -1);
            if (target.dataset.movedown) return reorderWithinSection(target.dataset.sectionId, target.dataset.movedown, 1);
        };
        list.oninput = event => {
            const target = event.target;
            if (target.matches('[data-section-title]')) {
                const section = sections.find(item => item.id === target.dataset.sectionTitle);
                if (section) section.title = target.value;
                renderSectionSelect();
                scheduleAutosave();
            }
            if (target.matches('[data-section-pick]')) {
                const section = sections.find(item => item.id === target.dataset.sectionPick);
                if (section) section.pickCount = Math.max(0, Number(target.value) || 0);
                scheduleAutosave();
            }
        };
        list.onchange = event => {
            const target = event.target;
            if (target.matches('[data-section-title]')) {
                const section = sections.find(item => item.id === target.dataset.sectionTitle);
                if (section) {
                    const index = sections.findIndex(item => item.id === section.id);
                    section.title = target.value.trim() || defaultSectionTitle(index);
                    target.value = section.title;
                    renderSectionSelect();
                    scheduleAutosave();
                }
            }
            if (target.matches('[data-section-shuffleq]')) updateSection(target.dataset.sectionShuffleq, { shuffleQuestions: target.checked }, { render: false });
            if (target.matches('[data-section-shufflec]')) updateSection(target.dataset.sectionShufflec, { shuffleChoices: target.checked }, { render: false });
            if (target.matches('input[type="radio"][name="qCorrect"]')) correctChoiceIndex = Number(target.value);
        };
    }
    const sectionSelect = $('qSection');
    const smartSectionSelect = $('smartPasteSection');
    if (sectionSelect) {
        sectionSelect.onchange = () => {
            activeSectionId = sectionSelect.value;
            if (smartSectionSelect) smartSectionSelect.value = activeSectionId;
        };
    }
    if (smartSectionSelect) {
        smartSectionSelect.onchange = () => {
            activeSectionId = smartSectionSelect.value;
            if (sectionSelect) sectionSelect.value = activeSectionId;
        };
    }
}

function reset() {
    editing = null;
    lastAutosaveSignature = '';
    clearTimeout(autosaveTimer);
    $('form').reset();
    $('duration').value = 30;
    ensureSecuritySettingsUi();
    applySecuritySettings({ security: MODE_DEFAULTS.standard });
    sections = [createSection()];
    activeSectionId = sections[0].id;
    questions = [];
    choiceDraft = [];
    correctChoiceIndex = 0;
    clearDraft();
    ensureBuilderUi();
    closeGuidedQuestionEditor({ clear: true, scroll: false });
    renderQ();
    setBuilderLock();
    $('bldSub') && ($('bldSub').textContent = 'Create a new Turso test');
}

function currentAssessment() {
    return {
        id: editing || '',
        title: $('title').value.trim(),
        instructions: $('instructions').value.trim(),
        subject_code: $('subject').value,
        section: $('section').value,
        status: $('status').value,
        duration_minutes: Number($('duration').value || 30),
        opens_at: iso($('opensAt').value),
        closes_at: iso($('closesAt').value),
        settings: (() => { const security = collectSecuritySettings(); return { security, fullscreen: security.requireFullscreen, maxViolations: security.warningLimit, autoSubmitOnViolation: security.autoSubmitAfterFinalViolation, builderSections: builderSettingsSnapshot() }; })()
    };
}

async function save(event) {
    event.preventDefault();
    const assessment = currentAssessment();
    if (!assessment.title || !assessment.subject_code || !assessment.section) return toast('Complete the title, subject, and section first.');
    if (assessment.status === 'published' && !questions.length) return toast('Add at least one question before publishing.');
    try {
        setSaveIndicator('saving');
        const data = await api('admin/save', { method: 'POST', body: JSON.stringify({ assessment, questions }) });
        editing = data.id;
        assessment.id = data.id;
        broadcastAssessmentChange('saved', data.id);
        lastAutosaveSignature = autosaveSignature(assessment, questions);
        persistDraft();
        setBuilderLock();
        updateAssessmentContext('builder');
        setSaveIndicator('saved');
        toast('Test saved. Continue adding questions below.');
        await loadAssessments();
        showWorkspace('builder');
        syncAssessmentHistory('builder', data.id, false, true);
    } catch (error) {
        setSaveIndicator('error');
        toast(error.message);
    }
}

async function loadAssessments() {
    try {
        const data = await api('admin/list');
        assessments = data.assessments || [];
        renderAssessments();
    } catch (error) {
        $('list').innerHTML = `<p class="mini">Turso assessment service is not ready: ${esc(error.message)}</p>`;
    }
}

function compactDate(value) {
    if (!value) return 'Not scheduled';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Not scheduled';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function assessmentStatusMeta(status = 'draft') {
    const value = String(status || 'draft').toLowerCase();
    return {
        draft: { label: 'Draft', icon: 'ph-pencil-line', className: 'draft' },
        published: { label: 'Published', icon: 'ph-broadcast', className: 'published' },
        closed: { label: 'Closed', icon: 'ph-lock-key', className: 'closed' },
        archived: { label: 'Archived', icon: 'ph-archive', className: 'archived' }
    }[value] || { label: value, icon: 'ph-circle', className: 'draft' };
}

function filteredAssessments() {
    const query = assessmentListFilters.search.trim().toLowerCase();
    return assessments.filter(assessment => {
        const matchesSearch = !query || [assessment.title, assessment.subject_code, assessment.section, assessment.instructions]
            .some(value => String(value || '').toLowerCase().includes(query));
        const matchesStatus = assessmentListFilters.status === 'all' || assessment.status === assessmentListFilters.status;
        const matchesSection = assessmentListFilters.section === 'all' || assessment.section === assessmentListFilters.section;
        return matchesSearch && matchesStatus && matchesSection;
    });
}

function assessmentCardMarkup(assessment) {
    const status = assessmentStatusMeta(assessment.status);
    const instructions = String(assessment.instructions || '').trim();
    return `
        <article class="assessment-card assessment-library-card" data-assessment-card="${esc(assessment.id)}">
            <div class="assessment-card-topline">
                <span class="assessment-status ${status.className}"><i class="ph-fill ${status.icon}"></i>${esc(status.label)}</span>
                <span class="assessment-updated"><i class="ph-bold ph-clock-counter-clockwise"></i>Updated ${esc(compactDate(assessment.updated_at || assessment.created_at))}</span>
            </div>
            <div class="assessment-card-heading">
                <div class="assessment-card-icon"><i class="ph-fill ph-exam"></i></div>
                <div>
                    <h3>${esc(assessment.title || 'Untitled assessment')}</h3>
                    <p>${esc(instructions || 'No instructions were added for this test.')}</p>
                </div>
            </div>
            <div class="assessment-card-meta-grid">
                <div class="assessment-card-meta"><span>Subject</span><strong>${esc(assessment.subject_code || '—')}</strong></div>
                <div class="assessment-card-meta"><span>Class section</span><strong>${esc(assessment.section || '—')}</strong></div>
                <div class="assessment-card-meta"><span>Duration</span><strong>${Number(assessment.duration_minutes || 0)} min</strong></div>
                <div class="assessment-card-meta"><span>Question bank</span><strong>${Number(assessment.question_count || 0)} questions</strong></div>
            </div>
            <div class="assessment-card-stats" aria-label="Assessment activity">
                <span><i class="ph-bold ph-users"></i><b>${Number(assessment.attempt_count || 0)}</b> submissions</span>
                <span class="${Number(assessment.violation_count || 0) ? 'has-alert' : ''}"><i class="ph-bold ph-shield-warning"></i><b>${Number(assessment.violation_count || 0)}</b> anomalies</span>
                <span><i class="ph-bold ph-calendar-blank"></i>${esc(compactDate(assessment.opens_at))}</span>
            </div>
            <div class="assessment-card-footer">
                <div class="assessment-card-primary-actions">
                    <button class="btn primary" type="button" data-builder="${esc(assessment.id)}"><i class="ph-bold ph-list-checks"></i>Manage Questions</button>
                    <button class="btn secondary" type="button" data-edit="${esc(assessment.id)}"><i class="ph-bold ph-sliders-horizontal"></i>Details</button>
                </div>
                <div class="assessment-card-secondary-actions">
                    <button class="assessment-card-action" type="button" data-attempts="${esc(assessment.id)}" title="View student results"><i class="ph-bold ph-chart-bar"></i><span>Results</span></button>
                    <button class="assessment-card-action" type="button" data-duplicate="${esc(assessment.id)}" title="Duplicate this test for another class section"><i class="ph-bold ph-copy"></i><span>Duplicate</span></button>
                    <button class="assessment-card-action" type="button" data-audit="${esc(assessment.id)}" title="Open this test's anomaly log"><i class="ph-bold ph-shield-warning"></i><span>Audit</span></button>
                    <button class="assessment-card-action danger" type="button" data-delete="${esc(assessment.id)}" title="Delete assessment"><i class="ph-bold ph-trash"></i><span>Delete</span></button>
                </div>
            </div>
        </article>`;
}

function bindAssessmentCardActions() {
    document.querySelectorAll('[data-edit]').forEach(btn => btn.onclick = () => navigateAssessment('details', btn.dataset.edit));
    document.querySelectorAll('[data-builder]').forEach(btn => btn.onclick = () => navigateAssessment('builder', btn.dataset.builder));
    document.querySelectorAll('[data-attempts]').forEach(btn => btn.onclick = () => navigateAssessment('results', btn.dataset.attempts));
    document.querySelectorAll('[data-duplicate]').forEach(btn => btn.onclick = () => openDuplicateAssessment(btn.dataset.duplicate));
    document.querySelectorAll('[data-audit]').forEach(btn => btn.onclick = async () => {
        incidentAssessmentFilterId = btn.dataset.audit;
        await navigateAssessment('security', btn.dataset.audit);
    });
    document.querySelectorAll('[data-delete]').forEach(btn => btn.onclick = () => del(btn.dataset.delete));
}

function renderAssessmentCards() {
    const container = $('assessmentCards');
    if (!container) return;
    const filtered = filteredAssessments();
    const count = $('assessmentListCount');
    if (count) count.textContent = `${filtered.length} of ${assessments.length} test${assessments.length === 1 ? '' : 's'}`;
    container.innerHTML = filtered.length
        ? filtered.map(assessmentCardMarkup).join('')
        : `<div class="assessment-library-empty"><div><i class="ph-fill ph-magnifying-glass"></i></div><h3>No matching tests</h3><p>Try changing the search text or filters.</p><button class="btn secondary" type="button" id="clearAssessmentFilters">Clear filters</button></div>`;
    bindAssessmentCardActions();
    if ($('clearAssessmentFilters')) $('clearAssessmentFilters').onclick = () => {
        assessmentListFilters = { search: '', status: 'all', section: 'all' };
        renderAssessments();
    };
}

function renderAssessments() {
    const list = $('list');
    if (!assessments.length) {
        list.innerHTML = `<div class="assessment-library-empty"><div><i class="ph-fill ph-exam"></i></div><h3>No tests created yet</h3><p>Create your first assessment, add questions, and assign it to a class section.</p><button class="btn primary" type="button" id="emptyCreateAssessment"><i class="ph-bold ph-plus"></i>Create Test</button></div>`;
        if ($('emptyCreateAssessment')) $('emptyCreateAssessment').onclick = () => navigateAssessment('details', '', { isNew: true, focusTitle: true });
        return;
    }

    const sectionOptions = [...new Set(assessments.map(item => item.section).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    list.innerHTML = `
        <div class="assessment-library-toolbar">
            <label class="assessment-search"><i class="ph-bold ph-magnifying-glass"></i><input id="assessmentSearch" type="search" placeholder="Search by title, subject, or section" value="${esc(assessmentListFilters.search)}"></label>
            <select class="select assessment-filter" id="assessmentStatusFilter" aria-label="Filter tests by status">
                <option value="all">All statuses</option>
                <option value="draft" ${assessmentListFilters.status === 'draft' ? 'selected' : ''}>Draft</option>
                <option value="published" ${assessmentListFilters.status === 'published' ? 'selected' : ''}>Published</option>
                <option value="closed" ${assessmentListFilters.status === 'closed' ? 'selected' : ''}>Closed</option>
                <option value="archived" ${assessmentListFilters.status === 'archived' ? 'selected' : ''}>Archived</option>
            </select>
            <select class="select assessment-filter" id="assessmentSectionFilter" aria-label="Filter tests by class section">
                <option value="all">All sections</option>
                ${sectionOptions.map(section => `<option value="${esc(section)}" ${assessmentListFilters.section === section ? 'selected' : ''}>${esc(section)}</option>`).join('')}
            </select>
            <span class="assessment-list-count" id="assessmentListCount"></span>
        </div>
        <div class="assessment-library-grid" id="assessmentCards"></div>`;

    $('assessmentSearch').oninput = event => {
        assessmentListFilters.search = event.target.value;
        renderAssessmentCards();
    };
    $('assessmentStatusFilter').onchange = event => {
        assessmentListFilters.status = event.target.value;
        renderAssessmentCards();
    };
    $('assessmentSectionFilter').onchange = event => {
        assessmentListFilters.section = event.target.value;
        renderAssessmentCards();
    };
    renderAssessmentCards();
}

function duplicateSectionOptions(selectedValue = '') {
    const sourceOptions = [...($('section')?.options || [])]
        .filter(option => option.value)
        .map(option => ({ value: option.value, label: option.textContent || option.value }));
    if (selectedValue && !sourceOptions.some(option => option.value === selectedValue)) {
        sourceOptions.unshift({ value: selectedValue, label: selectedValue });
    }
    return sourceOptions.map(option => `<option value="${esc(option.value)}" ${option.value === selectedValue ? 'selected' : ''}>${esc(option.label)}</option>`).join('');
}

function ensureDuplicateAssessmentModal() {
    if ($('duplicateAssessmentModal')) return;
    document.body.insertAdjacentHTML('beforeend', `
        <div class="assessment-modal" id="duplicateAssessmentModal" role="dialog" aria-modal="true" aria-labelledby="duplicateAssessmentTitle" hidden>
            <div class="assessment-modal-backdrop" data-close-duplicate></div>
            <section class="assessment-modal-card">
                <header class="assessment-modal-header">
                    <div class="assessment-modal-icon"><i class="ph-fill ph-copy"></i></div>
                    <div><span>Reuse an existing test</span><h2 id="duplicateAssessmentTitle">Duplicate Assessment</h2><p>Copy all sections, questions, answers, points, and security settings to another class section.</p></div>
                    <button class="assessment-modal-close" type="button" data-close-duplicate aria-label="Close duplicate assessment dialog"><i class="ph-bold ph-x"></i></button>
                </header>
                <form id="duplicateAssessmentForm" class="assessment-modal-body">
                    <div class="duplicate-source-summary" id="duplicateSourceSummary"></div>
                    <div class="field"><label for="duplicateTitleInput">Name of duplicated test</label><input class="input" id="duplicateTitleInput" maxlength="140" required></div>
                    <div class="field"><label for="duplicateSectionSelect">Assign to class section</label><select class="select" id="duplicateSectionSelect" required></select><small>The copied assessment is independent. Editing it will not change the original test.</small></div>
                    <label class="duplicate-schedule-option"><input type="checkbox" id="duplicateKeepSchedule"><span><b>Keep original open and close dates</b><small>Leave this off when the new class follows a different schedule.</small></span></label>
                    <div class="duplicate-draft-note"><i class="ph-fill ph-info"></i><span>The duplicate will be saved as <b>Draft</b> so students cannot access it until you review and publish it.</span></div>
                    <footer class="assessment-modal-footer"><button class="btn secondary" type="button" data-close-duplicate>Cancel</button><button class="btn primary" type="submit" id="duplicateAssessmentSubmit"><i class="ph-bold ph-copy"></i>Duplicate Test</button></footer>
                </form>
            </section>
        </div>`);
    document.querySelectorAll('[data-close-duplicate]').forEach(button => button.addEventListener('click', closeDuplicateAssessment));
    $('duplicateAssessmentForm').addEventListener('submit', submitDuplicateAssessment);
}

function openDuplicateAssessment(id) {
    const source = assessments.find(item => item.id === id);
    if (!source) return toast('The selected assessment could not be found.');
    ensureDuplicateAssessmentModal();
    duplicateSourceId = id;
    $('duplicateTitleInput').value = `${source.title} (Copy)`;
    $('duplicateSectionSelect').innerHTML = duplicateSectionOptions(source.section);
    $('duplicateKeepSchedule').checked = false;
    $('duplicateSourceSummary').innerHTML = `<div><i class="ph-fill ph-exam"></i></div><span><small>Copying from</small><strong>${esc(source.title)}</strong><em>${esc(source.subject_code || 'No subject')} · ${esc(source.section || 'No section')} · ${Number(source.question_count || 0)} questions</em></span>`;
    const modal = $('duplicateAssessmentModal');
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('show'));
    document.body.classList.add('assessment-modal-open');
    setTimeout(() => $('duplicateTitleInput')?.focus(), 120);
}

function closeDuplicateAssessment() {
    const modal = $('duplicateAssessmentModal');
    if (!modal || modal.hidden) return;
    modal.classList.remove('show');
    document.body.classList.remove('assessment-modal-open');
    setTimeout(() => { modal.hidden = true; duplicateSourceId = ''; }, 180);
}

async function submitDuplicateAssessment(event) {
    event.preventDefault();
    const button = $('duplicateAssessmentSubmit');
    const title = $('duplicateTitleInput').value.trim();
    const section = $('duplicateSectionSelect').value;
    if (!duplicateSourceId || !title || !section) return toast('Enter a title and choose the target class section.');
    button.disabled = true;
    button.innerHTML = '<i class="ph-bold ph-spinner-gap duplicate-spinner"></i>Duplicating…';
    try {
        const data = await api('admin/duplicate', {
            method: 'POST',
            body: JSON.stringify({
                source_id: duplicateSourceId,
                title,
                section,
                keep_schedule: $('duplicateKeepSchedule').checked
            })
        });
        closeDuplicateAssessment();
        broadcastAssessmentChange('duplicated', data.id);
        await loadAssessments();
        toast(`Test duplicated for ${section}. It is saved as Draft.`);
        const card = document.querySelector(`[data-assessment-card="${CSS.escape(data.id)}"]`);
        card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card?.classList.add('assessment-card-highlight');
        setTimeout(() => card?.classList.remove('assessment-card-highlight'), 1800);
    } catch (error) {
        toast(error.message);
    } finally {
        button.disabled = false;
        button.innerHTML = '<i class="ph-bold ph-copy"></i>Duplicate Test';
    }
}

async function edit(id, workspace = 'details') {
    try {
        const data = await api('admin/get?id=' + encodeURIComponent(id));
        const a = data.assessment;
        editing = id;
        $('title').value = a.title || '';
        $('instructions').value = a.instructions || '';
        $('subject').value = a.subject_code || '';
        $('section').value = a.section || '';
        $('status').value = a.status || 'draft';
        $('duration').value = a.duration_minutes || 30;
        $('opensAt').value = a.opens_at ? String(a.opens_at).slice(0, 16) : '';
        $('closesAt').value = a.closes_at ? String(a.closes_at).slice(0, 16) : '';
        ensureSecuritySettingsUi();
        applySecuritySettings(a.settings || {});
        sections = Array.isArray(a.settings?.builderSections) && a.settings.builderSections.length ? a.settings.builderSections : [];
        questions = data.questions || [];
        normalizeBuilderState();
        lastAutosaveSignature = autosaveSignature(a, questions);
        persistDraft();
        ensureBuilderUi();
        renderQ();
        setBuilderLock();
        showWorkspace(workspace);
        window.scrollTo({ top: 0, behavior: 'auto' });
        return true;
    } catch (error) {
        toast(error.message);
        return false;
    }
}

async function del(id) {
    if (!confirm('Delete this Turso assessment?')) return;
    try {
        await api('admin/delete', { method: 'POST', body: JSON.stringify({ id }) });
        if (editing === id) reset();
        broadcastAssessmentChange('deleted', id);
        toast('Deleted.');
        loadAssessments();
    } catch (error) {
        toast(error.message);
    }
}

async function attempts(id) {
    try {
        const data = await api('admin/attempts?assessment_id=' + encodeURIComponent(id));
        const attempts = data.attempts || [];
        $('attempts').innerHTML = attempts.length ? `
            <div class="table-wrap"><table class="assessment-table">
                <thead><tr><th>Student</th><th>Status</th><th>Score</th><th>Anomalies</th><th>Submitted</th></tr></thead>
                <tbody>${attempts.map(a => `<tr><td>${esc(a.student_name || a.student_no)}</td><td>${esc(a.status)}</td><td>${Number(a.score || 0)} / ${Number(a.total_points || 0)}</td><td>${Number(a.violations || 0)}</td><td>${a.submitted_at ? esc(new Date(a.submitted_at).toLocaleString()) : '-'}</td></tr>`).join('')}</tbody>
            </table></div>` : '<p class="mini">No submissions yet.</p>';
    } catch (error) {
        $('attempts').innerHTML = `<p class="mini">${esc(error.message)}</p>`;
    }
}

function incidentTypeLabel(type = '') {
    return incidentLabel(type);
}

function incidentSeverity(itemOrType = '') {
    if (itemOrType && typeof itemOrType === 'object' && itemOrType.severity) return String(itemOrType.severity).toLowerCase();
    const normalized = canonicalIncidentCode(itemOrType);
    if (['duplicate_device_session','session_replaced','anomaly_limit_reached','screen_share_stopped','secure_browser_failed'].includes(normalized)) return 'critical';
    if (['duplicate_exam_tab','print_attempt','fullscreen_exit','camera_stopped','microphone_stopped'].includes(normalized)) return 'high';
    if (['tab_switch','window_focus_lost','restricted_shortcut','copy_attempt','paste_attempt','cut_attempt','page_exit'].includes(normalized)) return 'medium';
    if (normalized === 'network_reconnected' || normalized === 'session_recovered' || normalized === 'time_expired') return 'info';
    return 'low';
}

function readableIncidentDetails(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return 'No additional details';
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return Object.entries(parsed).map(([key, item]) => `${key.replace(/[_-]+/g, ' ')}: ${typeof item === 'object' ? JSON.stringify(item) : item}`).join(' · ');
    } catch (_) {}
    return raw;
}

function ensureAuditReviewModal() {
    if ($('auditReviewModal')) return;
    if (!$('auditReviewStyles')) document.head.insertAdjacentHTML('beforeend', `<style id="auditReviewStyles">
        .audit-review-modal{position:fixed;inset:0;z-index:2800;display:none;align-items:center;justify-content:center;padding:18px}.audit-review-modal.show{display:flex}.audit-review-backdrop{position:absolute;inset:0;background:rgba(15,23,42,.58);backdrop-filter:blur(6px)}.audit-review-dialog{position:relative;width:min(960px,100%);max-height:min(90vh,920px);display:flex;flex-direction:column;background:var(--glass-bg);color:var(--text-main);border:1px solid var(--glass-border);border-radius:22px;box-shadow:0 24px 80px rgba(15,23,42,.28);overflow:hidden;backdrop-filter:blur(30px)}.audit-review-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;padding:18px 20px;border-bottom:1px solid rgba(100,116,139,.15)}.audit-review-head h2{font-size:18px;margin-bottom:3px}.audit-review-body{overflow:auto;overscroll-behavior:contain;padding:18px 20px;display:grid;gap:16px}.audit-detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:9px}.audit-detail-card{padding:11px;border-radius:13px;background:var(--accent-light);border:1px solid rgba(100,116,139,.12)}.audit-detail-card small{display:block;font-size:9px;color:var(--text-muted);font-weight:800;text-transform:uppercase}.audit-detail-card strong{display:block;font-size:12px;margin-top:4px}.audit-timeline{display:grid;gap:8px;max-height:300px;overflow:auto;padding-right:4px}.audit-timeline-item{display:grid;grid-template-columns:130px minmax(0,1fr);gap:12px;padding:10px 12px;border-radius:13px;border:1px solid rgba(100,116,139,.13);background:rgba(255,255,255,.35)}.dark-theme .audit-timeline-item{background:rgba(15,23,42,.42)}.audit-timeline-item time{font-size:10px;color:var(--text-muted);font-weight:800}.audit-timeline-item p{font-size:11px;line-height:1.5}.audit-review-form{display:grid;grid-template-columns:220px minmax(0,1fr);gap:10px}.audit-attempt-actions{display:flex;gap:8px;flex-wrap:wrap;padding:12px;border-radius:15px;background:var(--accent-light);border:1px solid rgba(100,116,139,.13)}.audit-review-footer{padding:14px 20px;border-top:1px solid rgba(100,116,139,.15);display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}.incident-badge.info{background:rgba(100,116,139,.11);color:var(--text-muted)}.incident-badge.critical{background:rgba(190,18,60,.13);color:#be123c}@media(max-width:650px){.audit-review-form{grid-template-columns:1fr}.audit-timeline-item{grid-template-columns:1fr}.audit-review-dialog{max-height:96vh}.audit-review-footer .btn{flex:1;justify-content:center}}
    </style>`);
    document.body.insertAdjacentHTML('beforeend', `<div class="audit-review-modal" id="auditReviewModal" aria-hidden="true"><div class="audit-review-backdrop" data-audit-close></div><section class="audit-review-dialog" role="dialog" aria-modal="true" aria-labelledby="auditReviewTitle"><header class="audit-review-head"><div><span class="audit-kicker"><i class="ph-fill ph-shield-check"></i>Administrator review</span><h2 id="auditReviewTitle">Review security event</h2><p class="mini" id="auditReviewSubtitle"></p></div><button class="btn secondary btn-icon" id="auditReviewClose" type="button" aria-label="Close review"><i class="ph-bold ph-x"></i></button></header><div class="audit-review-body"><div id="auditAttemptSummary"></div><div><h3 style="font-size:13px;margin-bottom:9px">Attempt timeline</h3><div class="audit-timeline" id="auditTimeline"></div></div><div><h3 style="font-size:13px;margin-bottom:9px">Review decision</h3><div class="audit-review-form"><select class="select" id="auditReviewStatus"><option value="reviewed">Reviewed</option><option value="false_positive">Likely false positive</option><option value="investigate">Flag for investigation</option><option value="archived">Archive event</option></select><textarea class="input" id="auditReviewNotes" rows="3" placeholder="Add review notes. Attempt actions require an audit reason."></textarea></div></div><div id="auditAttemptActionsWrap"><h3 style="font-size:13px;margin-bottom:9px">Authorized attempt actions</h3><div class="audit-attempt-actions"><button class="btn secondary btn-sm" type="button" id="auditFlagAttempt"><i class="ph-bold ph-flag"></i>Flag Attempt</button><button class="btn secondary btn-sm" type="button" id="auditApproveRecovery"><i class="ph-bold ph-arrows-clockwise"></i>Approve Recovery</button><button class="btn danger btn-sm" type="button" id="auditInvalidateAttempt"><i class="ph-bold ph-prohibit"></i>Invalidate</button><button class="btn secondary btn-sm" type="button" id="auditReopenAttempt"><i class="ph-bold ph-lock-open"></i>Reopen +30 min</button><label class="security-toggle-card" style="padding:7px 10px!important;min-width:190px"><input id="auditResetWarning" type="checkbox"><span><b>Reset warning score</b><small>Applied only when recovery is approved.</small></span></label></div><p class="mini" style="margin-top:7px">Every action is stored in the administrator audit trail. Incidents are never deleted here.</p></div></div><footer class="audit-review-footer"><button class="btn secondary" type="button" id="auditReviewCancel">Close</button><button class="btn primary" type="button" id="auditReviewSave"><i class="ph-bold ph-check"></i>Save Event Review</button></footer></section></div>`);
    const close = () => { $('auditReviewModal').classList.remove('show'); $('auditReviewModal').setAttribute('aria-hidden','true'); };
    $('auditReviewClose').onclick = close; $('auditReviewCancel').onclick = close; document.querySelector('#auditReviewModal [data-audit-close]').onclick = close;
    $('auditReviewSave').onclick = saveAuditReview;
    $('auditFlagAttempt').onclick = () => runAttemptAuditAction('review-attempt', 'flag this attempt', { review_status:'investigate' });
    $('auditApproveRecovery').onclick = () => runAttemptAuditAction('approve-session-recovery', 'approve session recovery', { reset_warning_count:$('auditResetWarning')?.checked === true });
    $('auditInvalidateAttempt').onclick = () => runAttemptAuditAction('invalidate-attempt', 'invalidate this attempt');
    $('auditReopenAttempt').onclick = () => runAttemptAuditAction('reopen-attempt', 'reopen this attempt', { extra_minutes:30 });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('auditReviewModal')?.classList.contains('show')) close(); });
}

async function openAuditReview(incident) {
    ensureAuditReviewModal();
    auditReviewIncidentId = incident.id || '';
    auditReviewAttemptId = incident.attempt_id || '';
    $('auditReviewTitle').textContent = incidentTypeLabel(incident.type);
    $('auditReviewSubtitle').textContent = `${incident.student_name || incident.student_no || 'Student'} • ${incident.assessment_title || 'Assessment'}`;
    $('auditReviewStatus').value = incident.review_status && incident.review_status !== 'unreviewed' ? incident.review_status : 'reviewed';
    $('auditReviewNotes').value = incident.review_notes || '';
    $('auditAttemptSummary').innerHTML = '<div class="audit-loading"><i class="ph-bold ph-spinner-gap duplicate-spinner"></i><span>Loading attempt summary…</span></div>';
    $('auditTimeline').innerHTML = '<div class="audit-loading"><span>Loading timeline…</span></div>';
    $('auditReviewModal').classList.add('show'); $('auditReviewModal').setAttribute('aria-hidden','false');
    $('auditAttemptActionsWrap').style.display = auditReviewAttemptId ? '' : 'none';
    if (!auditReviewAttemptId) {
        $('auditAttemptSummary').innerHTML = '<p class="mini">This legacy event is not linked to an attempt summary.</p>';
        $('auditTimeline').innerHTML = `<div class="audit-timeline-item"><time>${esc(new Date(incident.created_at).toLocaleString())}</time><p><b>${esc(incidentTypeLabel(incident.type))}</b><br>${esc(readableIncidentDetails(incident.details))}</p></div>`;
        return;
    }
    try {
        const [detail, timeline] = await Promise.all([
            api('admin/attempt-detail?attempt_id=' + encodeURIComponent(auditReviewAttemptId)),
            api('admin/attempt-timeline?attempt_id=' + encodeURIComponent(auditReviewAttemptId))
        ]);
        const a = detail.attempt || {}, summary = detail.summary || {};
        const sessionCards = (detail.sessions || []).map(session => `<div class="audit-detail-card"><small>Session ${esc(session.status || '')}</small><strong>${esc(session.device_type || 'device')} · ${esc(session.browser_name || 'browser')}</strong><small>${esc(session.started_at ? new Date(session.started_at).toLocaleString() : '')}${session.termination_reason ? ` · ${esc(session.termination_reason.replace(/_/g,' '))}` : ''}</small></div>`).join('');
        $('auditAttemptSummary').innerHTML = `<div class="audit-detail-grid"><div class="audit-detail-card"><small>Student</small><strong>${esc(a.student_name || a.student_no || '-')}</strong></div><div class="audit-detail-card"><small>Attempt</small><strong>#${Number(a.attempt_no || 1)} · ${esc(a.status || '-')}</strong></div><div class="audit-detail-card"><small>Submission reason</small><strong>${esc((a.submission_reason || 'In progress').replace(/_/g,' '))}</strong></div><div class="audit-detail-card"><small>Warning score</small><strong>${Number(a.warning_count || a.violations || 0)}</strong></div><div class="audit-detail-card"><small>Security score</small><strong>${Number(a.security_score || 0)}</strong></div><div class="audit-detail-card"><small>Highest severity</small><strong>${esc(summary.highest_severity || 'info')}</strong></div><div class="audit-detail-card"><small>Hidden duration</small><strong>${Number(summary.hidden_duration || 0).toFixed(1)} sec</strong></div><div class="audit-detail-card"><small>Offline duration</small><strong>${Number(summary.offline_duration || 0).toFixed(1)} sec</strong></div><div class="audit-detail-card"><small>Tab switches</small><strong>${Number(summary.tab_switch_count || 0)}</strong></div><div class="audit-detail-card"><small>Fullscreen exits</small><strong>${Number(summary.fullscreen_exit_count || 0)}</strong></div><div class="audit-detail-card"><small>Duplicate sessions</small><strong>${Number(summary.duplicate_session_count || 0)}</strong></div><div class="audit-detail-card"><small>Incident records</small><strong>${Number(summary.incident_count || 0)}</strong></div><div class="audit-detail-card"><small>Started</small><strong>${esc(a.started_at ? new Date(a.started_at).toLocaleString() : '-')}</strong></div><div class="audit-detail-card"><small>Deadline</small><strong>${esc(a.deadline_at ? new Date(a.deadline_at).toLocaleString() : '-')}</strong></div><div class="audit-detail-card"><small>Submitted</small><strong>${esc(a.submitted_at ? new Date(a.submitted_at).toLocaleString() : '-')}</strong></div><div class="audit-detail-card"><small>Review status</small><strong>${esc(a.review_status || 'unreviewed')}</strong></div>${sessionCards}</div>`;
        const groups = timeline.groups || [];
        $('auditTimeline').innerHTML = groups.length ? groups.map(group => `<div class="audit-timeline-item"><time>${esc(new Date(group.first_created_at).toLocaleString())}${group.count > 1 ? `<br>${group.count} grouped records` : ''}</time><p><b>${esc(incidentTypeLabel(group.type))}</b> <span class="incident-badge ${esc(group.highest_severity || 'low')}">${esc(group.highest_severity || 'low')}</span><br>${esc(readableIncidentDetails(group.details))}${Number(group.duration_seconds || 0) ? `<br><small>Total duration: ${Number(group.duration_seconds).toFixed(1)} seconds</small>` : ''}</p></div>`).join('') : '<p class="mini">No timeline events found.</p>';
    } catch (error) {
        $('auditAttemptSummary').innerHTML = `<p class="mini">${esc(error.message)}</p>`;
    }
}

async function saveAuditReview() {
    if (!auditReviewIncidentId) return;
    const button = $('auditReviewSave'); button.disabled = true;
    try {
        await api('admin/review-incident', { method:'POST', body:JSON.stringify({ incident_id:auditReviewIncidentId, review_status:$('auditReviewStatus').value, review_notes:$('auditReviewNotes').value.trim() }) });
        $('auditReviewModal').classList.remove('show');
        toast('Security event review saved.');
        await incidents(true);
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
}

async function runAttemptAuditAction(path, label, extra = {}) {
    if (!auditReviewAttemptId) return toast('This event is not linked to an attempt.');
    const notes = $('auditReviewNotes').value.trim();
    if (!notes) return toast(`Add an audit reason before you ${label}.`);
    const buttons = ['auditFlagAttempt','auditApproveRecovery','auditInvalidateAttempt','auditReopenAttempt'].map($).filter(Boolean);
    buttons.forEach(button => button.disabled = true);
    try {
        const body = path === 'review-attempt'
            ? { attempt_id:auditReviewAttemptId, review_notes:notes, ...extra }
            : { attempt_id:auditReviewAttemptId, reason:notes, ...extra };
        await api(`admin/${path}`, { method:'POST', body:JSON.stringify(body) });
        toast(`Attempt action completed: ${label}.`);
        await incidents(true);
        $('auditReviewModal').classList.remove('show');
    } catch (error) { toast(error.message); }
    finally { buttons.forEach(button => button.disabled = false); }
}

function localIncidentFilter(items) {
    const query = incidentSearch.trim().toLowerCase();
    return items.filter(incident => {
        const matchesType = incidentTypeFilter === 'all' || canonicalIncidentCode(incident.type) === canonicalIncidentCode(incidentTypeFilter);
        const matchesSearch = !query || [incident.student_no, incident.student_name, incident.type, incident.details, incident.assessment_title, incident.assessment_section, incident.attempt_no].some(value => String(value || '').toLowerCase().includes(query));
        return matchesType && matchesSearch;
    });
}

function renderIncidentManager() {
    const filtered = localIncidentFilter(incidentCache);
    const typeOptions = [...new Set(incidentCache.map(item => canonicalIncidentCode(item.type)).filter(Boolean))].sort();
    const sectionsList = [...new Set(assessments.map(item => item.section).filter(Boolean))].sort();
    const uniqueStudents = new Set(filtered.map(item => item.student_no).filter(Boolean)).size;
    const highRiskCount = filtered.filter(item => ['high','critical'].includes(incidentSeverity(item))).length;
    const latest = filtered[0]?.created_at ? new Date(filtered[0].created_at).toLocaleString() : 'No events';
    const selectedAssessment = incidentAssessmentFilterId ?? '';

    $('attempts').innerHTML = `<section class="audit-manager"><div class="audit-manager-header"><div><span class="audit-kicker"><i class="ph-fill ph-shield-check"></i>Security audit trail</span><h2>Anomaly Log</h2><p>Filter, review, and export server-validated assessment security events.</p></div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn secondary" type="button" id="exportIncidents"><i class="ph-bold ph-download-simple"></i>Export CSV</button><button class="btn secondary" type="button" id="refreshIncidents"><i class="ph-bold ph-arrow-clockwise"></i>Refresh Log</button></div></div>
    <div class="audit-summary-grid"><div class="audit-summary"><i class="ph-fill ph-warning-circle"></i><span><small>Loaded events</small><strong>${filtered.length}</strong></span></div><div class="audit-summary"><i class="ph-fill ph-student"></i><span><small>Students involved</small><strong>${uniqueStudents}</strong></span></div><div class="audit-summary ${highRiskCount ? 'alert' : ''}"><i class="ph-fill ph-siren"></i><span><small>High or critical</small><strong>${highRiskCount}</strong></span></div><div class="audit-summary"><i class="ph-fill ph-clock"></i><span><small>Latest event</small><strong>${esc(latest)}</strong></span></div></div>
    <details class="audit-filter-panel" open><summary><span><i class="ph-bold ph-funnel"></i>Audit filters</span><small>Filter by test, student, attempt, session, risk, and review status</small></summary><div class="audit-filters"><label><span>Test or exam</span><select class="select" id="incidentAssessmentFilter"><option value="">All tests</option>${assessments.map(item => `<option value="${esc(item.id)}" ${selectedAssessment === item.id ? 'selected' : ''}>${esc(item.title)} — ${esc(item.section || 'No section')}</option>`).join('')}</select></label><label><span>Section</span><select class="select" id="incidentSectionFilter"><option value="all">All sections</option>${sectionsList.map(value => `<option value="${esc(value)}" ${incidentFilters.section===value?'selected':''}>${esc(value)}</option>`).join('')}</select></label><label><span>Student number</span><input class="input" id="incidentStudentFilter" value="${esc(incidentFilters.student)}" placeholder="Exact student no."></label><label><span>Attempt ID</span><input class="input" id="incidentAttemptFilter" value="${esc(incidentFilters.attempt)}" placeholder="Attempt ID"></label><label><span>Session ID</span><input class="input" id="incidentSessionFilter" value="${esc(incidentFilters.session)}" placeholder="Session ID"></label><label><span>Event type</span><select class="select" id="incidentTypeFilter"><option value="all">All event types</option>${typeOptions.map(type => `<option value="${esc(type)}" ${incidentTypeFilter===type?'selected':''}>${esc(incidentTypeLabel(type))}</option>`).join('')}</select></label><label><span>Event group</span><select class="select" id="incidentCategoryFilter"><option value="all">All event groups</option><option value="duplicate_session" ${incidentFilters.category==='duplicate_session'?'selected':''}>Duplicate sessions</option><option value="automatic_submission" ${incidentFilters.category==='automatic_submission'?'selected':''}>Automatic submissions</option><option value="connection" ${incidentFilters.category==='connection'?'selected':''}>Connection events</option></select></label><label><span>Severity</span><select class="select" id="incidentSeverityFilter"><option value="all">All severities</option>${['info','low','medium','high','critical'].map(value=>`<option value="${value}" ${incidentFilters.severity===value?'selected':''}>${value}</option>`).join('')}</select></label><label><span>Submission reason</span><select class="select" id="incidentSubmissionFilter"><option value="all">All reasons</option>${['manual_submit','time_expired','anomaly_limit_reached','administrator_invalidated'].map(value=>`<option value="${value}" ${incidentFilters.submission===value?'selected':''}>${value.replace(/_/g,' ')}</option>`).join('')}</select></label><label><span>Review</span><select class="select" id="incidentReviewFilter"><option value="all">All review statuses</option><option value="unreviewed" ${incidentFilters.review==='unreviewed'?'selected':''}>Unreviewed</option><option value="reviewed" ${incidentFilters.review==='reviewed'?'selected':''}>Reviewed</option><option value="false_positive" ${incidentFilters.review==='false_positive'?'selected':''}>Likely false positive</option><option value="investigate" ${incidentFilters.review==='investigate'?'selected':''}>Investigation</option></select></label><label><span>From date</span><input class="input" id="incidentDateFrom" type="date" value="${esc(incidentFilters.dateFrom)}"></label><label><span>To date</span><input class="input" id="incidentDateTo" type="date" value="${esc(incidentFilters.dateTo)}"></label><label class="audit-search"><span>Search loaded events</span><div><i class="ph-bold ph-magnifying-glass"></i><input class="input" id="incidentSearch" type="search" value="${esc(incidentSearch)}" placeholder="Name, test, or details"></div></label></div></details>
    <div class="audit-result-bar"><span><b>${filtered.length}</b> event${filtered.length===1?'':'s'} loaded</span>${selectedAssessment ? `<button class="audit-clear-filter" type="button" id="showAllIncidents"><i class="ph-bold ph-x"></i>Show all tests</button>` : ''}</div>
    ${filtered.length ? `<div class="table-wrap audit-table-wrap"><table class="assessment-table audit-table"><thead><tr><th>Date and time</th><th>Test</th><th>Student and attempt</th><th>Security event</th><th>Details</th><th>Review</th></tr></thead><tbody>${filtered.map(item => { const severity=incidentSeverity(item); return `<tr><td><strong>${esc(new Date(item.created_at).toLocaleDateString())}</strong><small>${esc(new Date(item.created_at).toLocaleTimeString())}</small></td><td><strong>${esc(item.assessment_title || 'Deleted assessment')}</strong><small>${esc(item.subject_code || '')}${item.assessment_section?` · ${esc(item.assessment_section)}`:''}</small></td><td><strong>${esc(item.student_name || item.student_no || 'Unknown student')}</strong><small>${esc(item.student_no || '')}${item.attempt_no?` · Attempt ${Number(item.attempt_no)}`:''}</small></td><td><span class="incident-badge ${severity}"><i class="ph-fill ${['high','critical'].includes(severity)?'ph-siren':severity==='medium'?'ph-warning':'ph-info'}"></i>${esc(incidentTypeLabel(item.type))}</span><small>${esc(severity)} · weight ${Number(item.warning_weight || 0)}</small></td><td><span class="audit-details">${esc(readableIncidentDetails(item.details))}</span>${Number(item.duration_seconds||0)?`<small>${Number(item.duration_seconds).toFixed(1)} sec</small>`:''}</td><td><button class="btn secondary btn-sm" type="button" data-review-incident="${esc(item.id)}"><i class="ph-bold ph-magnifying-glass"></i>${item.review_status && item.review_status!=='unreviewed'?'Reviewed':'Review'}</button><small>${esc((item.review_status||'unreviewed').replace(/_/g,' '))}</small></td></tr>`; }).join('')}</tbody></table></div>` : `<div class="audit-empty"><i class="ph-fill ph-shield-check"></i><h3>No matching anomaly records</h3><p>There are no logged events for the selected filters.</p></div>`}
    ${incidentHasMore ? `<div style="display:flex;justify-content:center;margin-top:14px"><button class="btn secondary" id="loadMoreIncidents"><i class="ph-bold ph-arrow-down"></i>Load more events</button></div>` : ''}</section>`;

    const reload = () => { incidentCache=[]; incidentNextCursor=null; incidents(true); };
    $('refreshIncidents').onclick = reload;
    $('exportIncidents').onclick = exportIncidentAudit;
    $('incidentAssessmentFilter').onchange = event => { incidentAssessmentFilterId=event.target.value; reload(); };
    $('incidentSectionFilter').onchange = event => { incidentFilters.section=event.target.value; reload(); };
    $('incidentTypeFilter').onchange = event => { incidentTypeFilter=event.target.value; reload(); };
    $('incidentCategoryFilter').onchange = event => { incidentFilters.category=event.target.value; reload(); };
    $('incidentSeverityFilter').onchange = event => { incidentFilters.severity=event.target.value; reload(); };
    $('incidentSubmissionFilter').onchange = event => { incidentFilters.submission=event.target.value; reload(); };
    $('incidentReviewFilter').onchange = event => { incidentFilters.review=event.target.value; reload(); };
    $('incidentDateFrom').onchange = event => { incidentFilters.dateFrom=event.target.value; reload(); };
    $('incidentDateTo').onchange = event => { incidentFilters.dateTo=event.target.value; reload(); };
    for (const [id,key] of [['incidentStudentFilter','student'],['incidentAttemptFilter','attempt'],['incidentSessionFilter','session']]) {
        $(id).onchange = event => { incidentFilters[key]=event.target.value.trim(); reload(); };
    }
    $('incidentSearch').oninput = event => { incidentSearch=event.target.value; clearTimeout(incidentSearchTimer); incidentSearchTimer=setTimeout(()=>{ renderIncidentManager(); const input=$('incidentSearch'); input?.focus(); input?.setSelectionRange(input.value.length,input.value.length); },140); };
    document.querySelectorAll('[data-review-incident]').forEach(button => button.onclick = () => { const incident=incidentCache.find(item=>item.id===button.dataset.reviewIncident); if(incident) openAuditReview(incident); });
    if ($('loadMoreIncidents')) $('loadMoreIncidents').onclick = () => incidents(false, true);
    if ($('showAllIncidents')) $('showAllIncidents').onclick = () => { incidentAssessmentFilterId=''; reload(); };
}

function incidentQuery(cursor = '') {
    const params = new URLSearchParams();
    if (incidentAssessmentFilterId) params.set('assessment_id', incidentAssessmentFilterId);
    if (incidentFilters.section !== 'all') params.set('section', incidentFilters.section);
    if (incidentFilters.student) params.set('student_no', incidentFilters.student);
    if (incidentFilters.attempt) params.set('attempt_id', incidentFilters.attempt);
    if (incidentFilters.session) params.set('session_id', incidentFilters.session);
    if (incidentTypeFilter !== 'all') params.set('type', canonicalIncidentCode(incidentTypeFilter));
    if (incidentFilters.category !== 'all') params.set('category', incidentFilters.category);
    if (incidentFilters.severity !== 'all') params.set('severity', incidentFilters.severity);
    if (incidentFilters.review !== 'all') params.set('review_status', incidentFilters.review);
    if (incidentFilters.submission !== 'all') params.set('submission_reason', incidentFilters.submission);
    if (incidentFilters.dateFrom) params.set('date_from', `${incidentFilters.dateFrom}T00:00:00.000Z`);
    if (incidentFilters.dateTo) params.set('date_to', `${incidentFilters.dateTo}T23:59:59.999Z`);
    if (cursor) params.set('cursor', cursor);
    params.set('limit','100');
    return params;
}

async function incidents(force = false, append = false) {
    if (incidentAssessmentFilterId === null) incidentAssessmentFilterId = editing || '';
    if (!append) $('attempts').innerHTML = '<div class="audit-loading"><i class="ph-bold ph-spinner-gap duplicate-spinner"></i><span>Loading security audit trail…</span></div>';
    try {
        const data = await api('admin/incidents?' + incidentQuery(append ? incidentNextCursor : '').toString());
        incidentCache = append ? [...incidentCache, ...(data.incidents || [])] : (data.incidents || []);
        incidentNextCursor = data.next_cursor || null; incidentHasMore = !!data.has_more;
        renderIncidentManager();
    } catch (error) { $('attempts').innerHTML = `<div class="audit-empty error"><i class="ph-fill ph-warning-circle"></i><h3>Could not load anomaly records</h3><p>${esc(error.message)}</p></div>`; }
}

async function exportIncidentAudit() {
    try {
        const params = incidentQuery(''); params.delete('limit');
        const response = await fetch('/api/assessments/admin/export-audit?' + params.toString(), { headers: { authorization: 'Bearer ' + await getToken() }, cache:'no-store' });
        if (!response.ok) throw new Error('Audit export failed.');
        const blob = await response.blob(), url=URL.createObjectURL(blob), link=document.createElement('a');
        link.href=url; link.download='assessment-security-audit.csv'; link.click(); URL.revokeObjectURL(url);
    } catch (error) { toast(error.message); }
}

$('qType').onchange = () => {
    const type = $('qType').value;
    choiceDraft = [];
    correctChoiceIndex = 0;
    initChoiceDraft(type);
    renderChoiceEditor();
    updateAnswerKeyUi();
    syncGuidedQuestionTypeUi(type, true);
};

$('addQ').onclick = () => {
    const type = $('qType').value;
    const prompt = $('qPrompt').value.trim();
    if (!prompt) return toast('Please type the question.');
    const sectionId = $('qSection')?.value || activeSectionId || sections[0]?.id || '';
    const q = { id: uid('q'), sectionId, type, prompt, points: Number($('qPoints').value || 1), answer_key: '', choices: [], order_no: questions.length + 1 };
    if (type === 'multiple_choice' || type === 'true_false') {
        const choices = questionDraftFromUi();
        if (choices.length < 2) return toast('Add at least two choices.');
        const normalized = choices.map(choice => choice.toLowerCase());
        if (new Set(normalized).size !== normalized.length) return toast('Choices must be different from each other.');
        const correctChoice = String(choiceDraft[correctChoiceIndex] || '').trim();
        if (!correctChoice || !choices.includes(correctChoice)) return toast('Select a valid correct answer.');
        q.choices = choices;
        q.answer_key = correctChoice;
    } else if (type === 'short_answer') {
        q.answer_key = $('qAnswer').value.trim();
    }
    questions.push(q);
    renumberQuestions();
    scheduleAutosave();
    $('qPrompt').value = '';
    $('qPoints').value = '1';
    $('qAnswer').value = '';
    choiceDraft = [];
    correctChoiceIndex = 0;
    inlinePasteUndo = null;
    if ($('inlinePasteFeedback')) $('inlinePasteFeedback').hidden = true;
    renderChoiceEditor();
    updateAnswerKeyUi();
    renderQ();
    toast(`${QUESTION_TYPE_META[type]?.name || 'Question'} added successfully.`);
    closeGuidedQuestionEditor({ clear: false, scroll: true });
};

$('form').onsubmit = save;
$('newBtn').onclick = () => navigateAssessment('details', '', { isNew: true, focusTitle: true });
$('headerNewAssessment') && ($('headerNewAssessment').onclick = () => navigateAssessment('details', '', { isNew: true, focusTitle: true }));
$('libraryNewAssessment') && ($('libraryNewAssessment').onclick = () => navigateAssessment('details', '', { isNew: true, focusTitle: true }));
$('backToTests') && ($('backToTests').onclick = () => navigateAssessment('tests'));
$('refresh').onclick = loadAssessments;
document.querySelectorAll('[data-assessment-view]').forEach(btn => btn.onclick = () => {
    const target = btn.dataset.assessmentView;
    if (target === 'tests') return navigateAssessment('tests');
    if (target === 'details') return editing
        ? navigateAssessment('details', editing)
        : (showWorkspace('details'), syncAssessmentHistory('details', '', true), setTimeout(() => $('title')?.focus(), 80));
    if ((target === 'builder' || target === 'results') && !editing) {
        return toast(target === 'builder' ? 'Save or select a test before opening Questions Manager.' : 'Select a test before viewing results.');
    }
    return navigateAssessment(target, editing || '');
});
document.querySelectorAll('#form input, #form textarea, #form select, #qType, #qPoints, #qPrompt, #qAnswer, #qSection, #smartPasteSection').forEach(input => {
    input.addEventListener('input', () => {
        scheduleAutosave();
        if (input.id === 'title') updateAssessmentContext(currentWorkspace);
    });
    input.addEventListener('change', scheduleAutosave);
});
window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('questionBankModal')?.classList.contains('show')) {
        $('questionBankClose')?.click();
    }
    if (event.key === 'Escape' && $('duplicateAssessmentModal')?.classList.contains('show')) {
        closeDuplicateAssessment();
    }
});
window.addEventListener('beforeunload', persistDraft);
window.addEventListener('popstate', async () => {
    const params = new URLSearchParams(location.search);
    const workspace = params.get('workspace') || 'tests';
    const id = params.get('id') || '';
    const isNew = params.get('new') === '1';
    await navigateAssessment(workspace, id, { isNew, updateHistory: false });
});

theme();
setupStandaloneShell();
ensureBuilderUi();
await loadSelects();
await loadAssessments();
const restoredDraft = restoreDraft();
if (!restoredDraft) renderQ();
setBuilderLock();

if (requestedNew) {
    await navigateAssessment('details', '', { isNew: true, replace: true, focusTitle: true });
} else if (requestedAssessmentId) {
    await navigateAssessment(requestedWorkspace, requestedAssessmentId, { replace: true });
} else {
    showWorkspace(requestedWorkspace === 'tests' ? 'tests' : requestedWorkspace);
    syncAssessmentHistory(currentWorkspace, currentWorkspace === 'tests' ? '' : (editing || ''), false, true);
}

adminChannel && (adminChannel.onmessage = loadAssessments);
window.addEventListener('storage', event => {
    if (event.key === 'plvAdminAssessmentChange') loadAssessments();
});
