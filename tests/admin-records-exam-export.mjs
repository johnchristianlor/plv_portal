import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {summarizeExamPoints, uniqueSheetName, sortRecordRows, escapeCsvCell} from '../public/admin-records-utils.mjs';

const activities = [
  {id: 'lab-mid', section: 'A', subjectCode: 'IT101', term: 'midterm', category: 'exam', perfectScore: 50, title: 'Midterm Lab'},
  {id: 'written-mid', section: 'A', subjectCode: 'IT101', term: 'midterm', category: 'exam', perfectScore: 100, title: 'Midterm Written'},
  {id: 'lab-final', section: 'A', subjectCode: 'IT101', term: 'final', category: 'exam', perfectScore: 40, title: 'Final Lab'},
  {id: 'written-final', section: 'A', subjectCode: 'IT101', term: 'final', category: 'exam', perfectScore: 60, title: 'Final Written'},
  {id: 'homework', section: 'A', subjectCode: 'IT101', term: 'final', category: 'written', perfectScore: 30, title: 'Homework'},
  {id: 'other-class', section: 'B', subjectCode: 'IT101', term: 'midterm', category: 'exam', perfectScore: 200, title: 'Exam'},
  {id: 'other-subject', section: 'A', subjectCode: 'IT102', term: 'final', category: 'exam', perfectScore: 400, title: 'Exam'},
];
const scores = [
  {activityId:'lab-mid',studentNo:'s1',score:40},
  {activityId:'written-mid',studentNo:'s1',score:75},
  {activityId:'lab-final',studentNo:'s1',score:0},
  {activityId:'written-final',studentNo:'s1',score:54},
  {activityId:'homework',studentNo:'s1',score:30},
  {activityId:'other-class',studentNo:'s1',score:190},
  {activityId:'other-subject',studentNo:'s1',score:390},
  {activityId:'lab-mid',studentNo:'s2',score:0},
];
const scoreMap=Object.fromEntries(scores.map(s=>[s.activityId+'||'+s.studentNo,s]));

test('Four major exams, with mixed maximums, sum by section and subject only',()=>{
  const result=summarizeExamPoints(activities,scoreMap,'s1','A','IT101');
  assert.deepEqual(result.midterm,{earned:115,max:150,graded:2,pending:0});
  assert.deepEqual(result.final,{earned:54,max:100,graded:2,pending:0});
  assert.equal(result.combined.earned,169);
  assert.equal(result.combined.max,250);
  assert.equal(result.combined.graded,4);
  assert.equal(result.combined.pending,0);
  assert.equal(Number(result.combined.percentage.toFixed(5)),67.6);
  assert.equal(summarizeExamPoints(activities,scoreMap,'s1','B','IT101').combined.max,200);
  assert.equal(summarizeExamPoints(activities,scoreMap,'s1','A','IT102').combined.max,400);
});

test('Zero is graded and empty/pending is not recorded as a zero',()=>{
  const result=summarizeExamPoints(activities,scoreMap,'s2','A','IT101');
  assert.deepEqual(result.midterm,{earned:0,max:150,graded:1,pending:1});
  assert.deepEqual(result.combined,{earned:0,max:250,graded:1,pending:3,percentage:0});
  const noExam=summarizeExamPoints(activities,scoreMap,'s2','A','NONE');
  assert.equal(noExam.combined.percentage,null);
  assert.equal(noExam.combined.max,0);
  const blankMap={...scoreMap,'lab-mid||s2':{score:null}};
  assert.equal(summarizeExamPoints(activities,blankMap,'s2','A','IT101').combined.pending,4);
});

test('Excel worksheet naming is valid, case-insensitively unique and never over 31 characters',()=>{
  const used=new Set();
  const a=uniqueSheetName('IT/DEV:?*[] verylongsection123456789',used);
  const b=uniqueSheetName('IT/DEV:?*[] verylongsection123456789',used);
  const c=uniqueSheetName('EXAM TOTALS',used);
  assert.ok(a.length<=31&&b.length<=31);
  assert.ok(!/[\\/?*\[\]:]/.test(a));
  assert.notEqual(a.toLowerCase(),b.toLowerCase());
  assert.equal(c,'EXAM TOTALS');
});

// Evaluate the real admin-records export function with lightweight browser and
// SheetJS adapters. This checks generated cell structure, not just helper math.
const source = readFileSync(new URL('../public/admin-records.html', import.meta.url),'utf8');
const code = source.slice(source.indexOf('const examExportHeaders = ['),source.indexOf('// ========== THEME =========='));

function setupExport({format,includeExam=true,includeActivities=true,section='',subject=''}) {
  const opts={
    expSection:section, expSubject:subject, expOrder:'name_asc',
    expRanking:false, expActivities:includeActivities, expGrades:false,
    expStatus:false, expPercent:false, expExamTotals:includeExam,
  };
  const sheets=[];
  const saved={sheets};
  const XLSX={
    utils:{
      book_new:()=>({SheetNames:[],Sheets:{}}),
      aoa_to_sheet:data=>({'!ref':`A1:${encodeCol(data[0].length-1)}${data.length}`,data}),
      encode_col:encodeCol,
      decode_range:()=>({e:{r:3}}),
      book_append_sheet:(book,ws,name)=>{book.SheetNames.push(name);book.Sheets[name]=ws;sheets.push({name,ws});},
    },
    writeFile:(book,file)=>{saved.book=book;saved.file=file;},
  };
  const document={
    getElementById:id=>({value:opts[id]??'',checked:opts[id]??false}),
    createElement:()=>({set href(v){this._href=v;},click(){saved.downloadClicked=true;}}),
  };
  const ctx={
    window:{showToast:()=>{},closeExportModal:()=>{}},document,XLSX,
    URL:{createObjectURL:()=>''},Blob:class {constructor(items){saved.csv=items[0];}},
    loadVendor:async()=>{},enrollments:[
      {id:1,studentNo:'s1',studentName:'Ana',section:'A',subjectCode:'IT101',midtermGrade:1.5,finalTermGrade:2},
      {id:2,studentNo:'s2',studentName:'Ben',section:'A',subjectCode:'IT101',midtermGrade:2.25,finalTermGrade:2.5},
      {id:3,studentNo:'s1',studentName:'Ana',section:'B',subjectCode:'IT101',midtermGrade:1.5,finalTermGrade:2},
    ],
    activities, scores,
    buildSMap:()=>scoreMap,
    computeRows:(en,acts,sm)=>en.map(e=>({studentNo:e.studentNo,studentName:e.studentName,section:e.section,subjectCode:e.subjectCode,
      midGrade:e.midtermGrade,finGrade:e.finalTermGrade,avg:1.75,standingLabel:'Official',standingValue:1.75,
      totalScore:0,totalMax:0,scorePercent:0,rank:1,status:'Passed'})),
    assignRanks:r=>r,sortRecordRows,escapeCsvCell,summarizeExamPoints,uniqueSheetName,
    setTimeout:()=>{},console,
  };
  vm.runInNewContext(code,ctx,{filename:'admin-records-export.js'});
  return ctx.window.doExport(format).then(()=>saved);
}
function encodeCol(n){let result='';do{result=String.fromCharCode(65+n%26)+result;n=Math.floor(n/26)-1;}while(n>=0);return result;}

test('Excel adds summary sheet and correctly scoped totals to individual section sheets',async()=>{
  const {sheets}=await setupExport({format:'xlsx'});
  assert.equal(sheets.length,3);
  assert.equal(sheets[0].name,'Exam Totals');
  const summary=sheets[0].ws.data;
  assert.equal(summary[0].length,13);
  assert.deepEqual(Array.from(summary[0].slice(8,11)),['Combined Exam Points','Combined Exam Max','Combined Exam %']);
  assert.deepEqual(Array.from(summary[1].slice(8,13)),[169,250,0.676,4,0]);
  assert.deepEqual(Array.from(summary[2].slice(8,13)),[190,200,0.95,1,0]);
  assert.deepEqual(Array.from(summary[3].slice(8,13)),[0,250,0,1,3]);
  assert.match(sheets[1].name,/IT101 - A/);
  assert.match(sheets[2].name,/IT101 - B/);
  assert.equal(sheets[1].ws.data[0].filter(col=>col.includes('Exam Points')).length,3);
  assert.equal(sheets[2].ws.data[0].filter(col=>col.includes('[')).length,1);
});

test('CSV adds exam totals even when individual activity columns are disabled',async()=>{
  const {csv}=await setupExport({format:'csv',includeActivities:false});
  assert.ok(csv.startsWith('\uFEFF'));
  const lines=csv.slice(1).split('\r\n');
  assert.equal(lines.length,4);
  assert.ok(lines[0].includes('Combined Exam Points,Combined Exam Max,Combined Exam %'));
  assert.ok(lines[1].includes('169,250,67.60%,4,0'));
  assert.ok(lines[3].includes('0,250,0.00%,1,3'));
});

test('Disabling exam totals leaves default export unaffected',async()=>{
  const {sheets}=await setupExport({format:'xlsx',includeExam:false});
  assert.equal(sheets.length,2);
  assert.equal(sheets[0].ws.data[0].some(h=>h.includes('Combined Exam')),false);
});
