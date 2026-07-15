import { supabase } from './supabase-adapter.js';
import { startAdminSessionGuard } from './admin-session.js';

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

function ensureSecuritySettingsUi() {
    if ($('securitySettingsCard')) return;
    const grid = $('form')?.querySelector('.form-grid');
    if (!grid) return;
    grid.insertAdjacentHTML('beforeend', `
        <div class="field full" id="securitySettingsCard">
            <label>Exam Security</label>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;padding:14px;border:1px solid rgba(100,116,139,.16);border-radius:16px;background:rgba(255,255,255,.32)">
                <label style="display:flex;align-items:flex-start;gap:10px;padding:10px;border-radius:12px;background:var(--accent-light);color:var(--text-main);font-size:12px;font-weight:800;text-transform:none;letter-spacing:0;cursor:pointer"><input id="securityFullscreen" type="checkbox" checked style="margin-top:2px;accent-color:var(--accent-primary)"><span><b>Require fullscreen</b><small style="display:block;color:var(--text-muted);margin-top:3px">Pause the exam when fullscreen is exited.</small></span></label>
                <label style="display:flex;align-items:flex-start;gap:10px;padding:10px;border-radius:12px;background:var(--accent-light);color:var(--text-main);font-size:12px;font-weight:800;text-transform:none;letter-spacing:0;cursor:pointer"><input id="securityAutoSubmit" type="checkbox" checked style="margin-top:2px;accent-color:var(--accent-primary)"><span><b>Auto-submit at limit</b><small style="display:block;color:var(--text-muted);margin-top:3px">Submit when the anomaly threshold is reached.</small></span></label>
                <div style="padding:10px;border-radius:12px;background:var(--accent-light)"><label for="securityMaxViolations" style="font-size:11px">Anomaly limit</label><input class="input" id="securityMaxViolations" type="number" min="1" max="50" value="5" style="margin-top:6px"><small style="display:block;color:var(--text-muted);font-weight:700;margin-top:4px">Recommended: 3–5</small></div>
            </div>
            <p class="mini" style="margin-top:7px">Tab changes, focus loss, restricted shortcuts, clipboard actions, printing, duplicate exam tabs, and fullscreen exits are logged.</p>
        </div>`);
    ['securityFullscreen', 'securityAutoSubmit', 'securityMaxViolations'].forEach(id => {
        $(id)?.addEventListener('input', scheduleAutosave);
        $(id)?.addEventListener('change', scheduleAutosave);
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
        $('securityFullscreen').checked = assessment.settings?.fullscreen !== false;
        $('securityAutoSubmit').checked = assessment.settings?.autoSubmitOnViolation !== false;
        $('securityMaxViolations').value = Math.max(1, Number(assessment.settings?.maxViolations || 5));
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
    $('securityFullscreen').checked = true;
    $('securityAutoSubmit').checked = true;
    $('securityMaxViolations').value = 5;
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
        settings: { fullscreen: $('securityFullscreen')?.checked !== false, maxViolations: Math.max(1, Number($('securityMaxViolations')?.value || 5)), autoSubmitOnViolation: $('securityAutoSubmit')?.checked !== false, builderSections: builderSettingsSnapshot() }
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
        $('securityFullscreen').checked = a.settings?.fullscreen !== false;
        $('securityAutoSubmit').checked = a.settings?.autoSubmitOnViolation !== false;
        $('securityMaxViolations').value = Math.max(1, Number(a.settings?.maxViolations || 5));
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
    const normalized = String(type || '').toLowerCase();
    const labels = {
        tab_hidden: 'Tab switched', visibility_hidden: 'Tab switched', window_blur: 'Window lost focus',
        fullscreen_exit: 'Fullscreen exited', duplicate_tab: 'Duplicate exam tab', copy: 'Copy attempt',
        paste: 'Paste attempt', cut: 'Cut attempt', context_menu: 'Right-click attempt', print: 'Print attempt',
        restricted_shortcut: 'Restricted shortcut', offline: 'Internet disconnected', unload: 'Exam page closed',
        back_navigation: 'Back navigation', anomaly_limit: 'Anomaly limit reached'
    };
    return labels[normalized] || String(type || 'Unknown event').replace(/[_-]+/g, ' ').replace(/\b\w/g, value => value.toUpperCase());
}

function incidentSeverity(type = '') {
    const normalized = String(type || '').toLowerCase();
    if (['duplicate_tab', 'anomaly_limit', 'print', 'fullscreen_exit'].includes(normalized)) return 'high';
    if (['tab_hidden', 'visibility_hidden', 'window_blur', 'restricted_shortcut', 'copy', 'paste', 'cut', 'unload'].includes(normalized)) return 'medium';
    return 'low';
}

function readableIncidentDetails(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return 'No additional details';
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            return Object.entries(parsed).map(([key, item]) => `${key.replace(/[_-]+/g, ' ')}: ${typeof item === 'object' ? JSON.stringify(item) : item}`).join(' · ');
        }
    } catch (_) {}
    return raw;
}

function renderIncidentManager() {
    const query = incidentSearch.trim().toLowerCase();
    const filtered = incidentCache.filter(incident => {
        const matchesType = incidentTypeFilter === 'all' || incident.type === incidentTypeFilter;
        const matchesSearch = !query || [incident.student_no, incident.type, incident.details, incident.assessment_title, incident.assessment_section]
            .some(value => String(value || '').toLowerCase().includes(query));
        return matchesType && matchesSearch;
    });
    const typeOptions = [...new Set(incidentCache.map(item => item.type).filter(Boolean))].sort();
    const uniqueStudents = new Set(filtered.map(item => item.student_no).filter(Boolean)).size;
    const highRiskCount = filtered.filter(item => incidentSeverity(item.type) === 'high').length;
    const latest = filtered[0]?.created_at ? new Date(filtered[0].created_at).toLocaleString() : 'No events';
    const selectedAssessment = incidentAssessmentFilterId ?? '';

    $('attempts').innerHTML = `
        <section class="audit-manager">
            <div class="audit-manager-header">
                <div><span class="audit-kicker"><i class="ph-fill ph-shield-check"></i>Security audit trail</span><h2>Anomaly Log</h2><p>Review security events by test, student, and incident type.</p></div>
                <button class="btn secondary" type="button" id="refreshIncidents"><i class="ph-bold ph-arrow-clockwise"></i>Refresh Log</button>
            </div>
            <div class="audit-summary-grid">
                <div class="audit-summary"><i class="ph-fill ph-warning-circle"></i><span><small>Visible events</small><strong>${filtered.length}</strong></span></div>
                <div class="audit-summary"><i class="ph-fill ph-student"></i><span><small>Students involved</small><strong>${uniqueStudents}</strong></span></div>
                <div class="audit-summary ${highRiskCount ? 'alert' : ''}"><i class="ph-fill ph-siren"></i><span><small>High-priority events</small><strong>${highRiskCount}</strong></span></div>
                <div class="audit-summary"><i class="ph-fill ph-clock"></i><span><small>Latest event</small><strong>${esc(latest)}</strong></span></div>
            </div>
            <div class="audit-filters">
                <label><span>Test or exam</span><select class="select" id="incidentAssessmentFilter"><option value="">All tests</option>${assessments.map(item => `<option value="${esc(item.id)}" ${selectedAssessment === item.id ? 'selected' : ''}>${esc(item.title)} — ${esc(item.section || 'No section')}</option>`).join('')}</select></label>
                <label><span>Event type</span><select class="select" id="incidentTypeFilter"><option value="all">All event types</option>${typeOptions.map(type => `<option value="${esc(type)}" ${incidentTypeFilter === type ? 'selected' : ''}>${esc(incidentTypeLabel(type))}</option>`).join('')}</select></label>
                <label class="audit-search"><span>Search audit trail</span><div><i class="ph-bold ph-magnifying-glass"></i><input class="input" id="incidentSearch" type="search" value="${esc(incidentSearch)}" placeholder="Student number, test, or details"></div></label>
            </div>
            <div class="audit-result-bar"><span><b>${filtered.length}</b> event${filtered.length === 1 ? '' : 's'} shown</span>${selectedAssessment ? `<button class="audit-clear-filter" type="button" id="showAllIncidents"><i class="ph-bold ph-x"></i>Show all tests</button>` : ''}</div>
            ${filtered.length ? `<div class="table-wrap audit-table-wrap"><table class="assessment-table audit-table"><thead><tr><th>Date and time</th><th>Test</th><th>Student</th><th>Security event</th><th>Details</th></tr></thead><tbody>${filtered.map(item => {
                const severity = incidentSeverity(item.type);
                return `<tr><td><strong>${esc(new Date(item.created_at).toLocaleDateString())}</strong><small>${esc(new Date(item.created_at).toLocaleTimeString())}</small></td><td><strong>${esc(item.assessment_title || 'Deleted assessment')}</strong><small>${esc(item.subject_code || '')}${item.assessment_section ? ` · ${esc(item.assessment_section)}` : ''}</small></td><td><strong>${esc(item.student_no || 'Unknown student')}</strong><small>Student account</small></td><td><span class="incident-badge ${severity}"><i class="ph-fill ${severity === 'high' ? 'ph-siren' : severity === 'medium' ? 'ph-warning' : 'ph-info'}"></i>${esc(incidentTypeLabel(item.type))}</span></td><td><span class="audit-details">${esc(readableIncidentDetails(item.details))}</span></td></tr>`;
            }).join('')}</tbody></table></div>` : `<div class="audit-empty"><i class="ph-fill ph-shield-check"></i><h3>No matching anomaly records</h3><p>There are no logged events for the selected filters.</p></div>`}
        </section>`;

    $('refreshIncidents').onclick = () => incidents(true);
    $('incidentAssessmentFilter').onchange = event => {
        incidentAssessmentFilterId = event.target.value;
        incidentTypeFilter = 'all';
        incidentSearch = '';
        incidents(true);
    };
    $('incidentTypeFilter').onchange = event => {
        incidentTypeFilter = event.target.value;
        renderIncidentManager();
    };
    $('incidentSearch').oninput = event => {
        incidentSearch = event.target.value;
        clearTimeout(incidentSearchTimer);
        incidentSearchTimer = setTimeout(() => {
            renderIncidentManager();
            const input = $('incidentSearch');
            input?.focus();
            input?.setSelectionRange(input.value.length, input.value.length);
        }, 140);
    };
    if ($('showAllIncidents')) $('showAllIncidents').onclick = () => {
        incidentAssessmentFilterId = '';
        incidentTypeFilter = 'all';
        incidentSearch = '';
        incidents(true);
    };
}

async function incidents(force = false) {
    if (incidentAssessmentFilterId === null) incidentAssessmentFilterId = editing || '';
    $('attempts').innerHTML = '<div class="audit-loading"><i class="ph-bold ph-spinner-gap duplicate-spinner"></i><span>Loading security audit trail…</span></div>';
    try {
        const suffix = incidentAssessmentFilterId ? `?assessment_id=${encodeURIComponent(incidentAssessmentFilterId)}` : '';
        const data = await api('admin/incidents' + suffix);
        incidentCache = data.incidents || [];
        renderIncidentManager();
    } catch (error) {
        $('attempts').innerHTML = `<div class="audit-empty error"><i class="ph-fill ph-warning-circle"></i><h3>Could not load anomaly records</h3><p>${esc(error.message)}</p></div>`;
    }
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
