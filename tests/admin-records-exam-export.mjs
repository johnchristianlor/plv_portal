import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {
  summarizeExamPoints, uniqueSheetName, sortRecordRows, escapeCsvCell,
  buildActivityExportHeader, buildExamTotalHeader, formatExportMaximum, excelColumnName,
} from '../public/admin-records-utils.mjs';

const activities = [
  {id:'lab-mid',section:'A',subjectCode:'IT101',term:'midterm',category:'exam',perfectScore:50,title:'L-EXAM'},
  {id:'written-mid',section:'A',subjectCode:'IT101',term:'midterm',category:'exam',perfectScore:100,title:'Written Exam'},
  {id:'lab-final',section:'A',subjectCode:'IT101',term:'final',category:'exam',perfectScore:40,title:'Lab Final'},
  {id:'written-final',section:'A',subjectCode:'IT101',term:'final',category:'exam',perfectScore:60,title:'Written Final'},
  {id:'homework',section:'A',subjectCode:'IT101',term:'final',category:'written',perfectScore:30,title:'Homework'},
  {id:'other-class',section:'B',subjectCode:'IT101',term:'midterm',category:'exam',perfectScore:200,title:'Exam'},
  {id:'other-subject',section:'A',subjectCode:'IT102',term:'final',category:'exam',perfectScore:400,title:'Exam'},
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

test('Sum four exam types by subject/section, never include non-exam points',()=>{
  const result=summarizeExamPoints(activities,scoreMap,'s1','A','IT101');
  assert.deepEqual(result.midterm,{earned:115,max:150,graded:2,pending:0});
  assert.deepEqual(result.final,{earned:54,max:100,graded:2,pending:0});
  assert.deepEqual(result.combined,{earned:169,max:250,graded:4,pending:0,percentage:67.60000000000001});
  assert.equal(summarizeExamPoints(activities,scoreMap,'s1','B','IT101').combined.max,200);
  assert.equal(summarizeExamPoints(activities,scoreMap,'s1','A','IT102').combined.max,400);
});

test('Saved zero is graded; missing scores remain pending',()=>{
  const result=summarizeExamPoints(activities,scoreMap,'s2','A','IT101');
  assert.deepEqual(result.combined,{earned:0,max:250,graded:1,pending:3,percentage:0});
  const noExam=summarizeExamPoints(activities,scoreMap,'s2','A','NONE');
  assert.equal(noExam.combined.percentage,null);
  assert.equal(noExam.combined.max,0);
});

test('Compact headings include exact maximum and column names reach O/AA',()=>{
  assert.equal(buildActivityExportHeader({title:'L-EXAM',term:'midterm',perfectScore:40}),'[MID] L-EXAM (/40)');
  assert.equal(buildActivityExportHeader({title:'Lab Exam',term:'final',perfectScore:'15.50'}),'[FIN] Lab Exam (/15.5)');
  assert.equal(buildExamTotalHeader(250),'EXAMS TOTAL (/250)');
  assert.equal(formatExportMaximum('invalid'),'0');
  assert.equal(excelColumnName(15),'O');
  assert.equal(excelColumnName(27),'AA');
});

test('Sheet names are Excel-safe and distinct',()=>{
  const used=new Set();
  const a=uniqueSheetName('IT/DEV:?*[] verylongsection123456789',used);
  const b=uniqueSheetName('IT/DEV:?*[] verylongsection123456789',used);
  assert.ok(a.length<=31&&b.length<=31);
  assert.ok(!/[\\/?*\[\]:]/.test(a));
  assert.notEqual(a.toLowerCase(),b.toLowerCase());
});

// Test the real page export against a lightweight ExcelJS browser stand-in.
// This verifies the generated score columns, formulas, styles and values.
const source=readFileSync(new URL('../public/admin-records.html',import.meta.url),'utf8');
const code=source.slice(source.indexOf('// Keep maximum points in the column heading'),source.indexOf('// ========== THEME =========='));
class Cell {
  constructor(value){this.value=value;}
}
class Row {
  constructor(index,values=[]){this.number=index;this.cells=values.map(v=>new Cell(v));}
  getCell(index){while(this.cells.length<index)this.cells.push(new Cell(null));return this.cells[index-1];}
  eachCell(options,callback){
    const cb=typeof options==='function'?options:callback;
    this.cells.forEach((c,i)=>cb(c,i+1));
  }
}
class Sheet {
  constructor(name,options){this.name=name;this.options=options;this.rows=[];}
  set columns(definitions){this._columns=definitions;this.rows[0]=new Row(1,definitions.map(col=>col.header));}
  get columns(){return this._columns;}
  getRow(index){return this.rows[index-1];}
  addRow(values){const row=new Row(this.rows.length+1,values);this.rows.push(row);return row;}
}
class Workbook {
  constructor(){this.worksheets=[];this.xlsx={writeBuffer:async()=>new Uint8Array([80,75,3,4])};}
  addWorksheet(name,opts){const sh=new Sheet(name,opts);this.worksheets.push(sh);return sh;}
}
function setupExport({format='xlsx',includeExam=true,includeActivities=true,includePercent=false,section='',subject='' }={}){
  const opts={expSection:section,expSubject:subject,expOrder:'name_asc',
    expRanking:false,expActivities:includeActivities,expGrades:false,
    expStatus:false,expPercent:includePercent,expExamTotals:includeExam};
  const saved={};
  const document={
    getElementById:id=>({value:opts[id]??'',checked:opts[id]??false}),
    createElement:()=>({click(){saved.downloadClicked=true;},remove(){saved.linkRemoved=true;}}),
    body:{appendChild:link=>{saved.link=link;}},
  };
  const ctx={
    window:{showToast:(msg,type)=>{saved.toast={msg,type};},closeExportModal:()=>{}},
    document,ExcelJS:{Workbook},URL:{createObjectURL:()=>'/mock-export',revokeObjectURL:()=>{}},
    Blob:class{constructor(items){saved.blob=items;}},
    loadVendor:async()=>({Workbook}),
    enrollments:[
      {id:1,studentNo:'s1',studentName:'Ana',section:'A',subjectCode:'IT101',midtermGrade:1.5,finalTermGrade:2},
      {id:2,studentNo:'s2',studentName:'Ben',section:'A',subjectCode:'IT101',midtermGrade:2.25,finalTermGrade:2.5},
      {id:3,studentNo:'s1',studentName:'Ana',section:'B',subjectCode:'IT101',midtermGrade:1.5,finalTermGrade:2},
    ],activities,scores,buildSMap:()=>scoreMap,
    computeRows:(en)=>en.map(e=>({studentNo:e.studentNo,studentName:e.studentName,
      section:e.section,subjectCode:e.subjectCode,midGrade:e.midtermGrade,
      finGrade:e.finalTermGrade,avg:1.75,totalScore:0,totalMax:0,scorePercent:0,
      rank:1,status:'Passed'})),
    assignRanks:x=>x,sortRecordRows,escapeCsvCell,summarizeExamPoints,uniqueSheetName,
    buildActivityExportHeader,buildExamTotalHeader,formatExportMaximum,excelColumnName,
    setTimeout:()=>{},console,Date,
  };
  // Keep track of the created workbook without opening a real browser.
  class TrackedWorkbook extends Workbook {constructor(){super();saved.workbook=this;}}
  ctx.loadVendor=async()=>({Workbook:TrackedWorkbook});
  vm.runInNewContext(code,ctx,{filename:'admin-records-export.js'});
  return ctx.window.doExport(format).then(()=>saved);
}

test('Styled Excel has one class sheet, colored headers, four exams and one compact exam total',async()=>{
  const {workbook,downloadClicked,link}=await setupExport({section:'A',subject:'IT101'});
  assert.ok(downloadClicked);
  assert.match(link.download,/\.xlsx$/);
  assert.equal(workbook.worksheets.length,1);
  const ws=workbook.worksheets[0];
  const h=Array.from(ws.getRow(1).cells,c=>c.value);
  assert.deepEqual(h,[
    'Student No.','Student Name',
    '[MID] L-EXAM (/50)','[MID] Written Exam (/100)',
    '[FIN] Lab Final (/40)','[FIN] Written Final (/60)',
    '[FIN] Homework (/30)','EXAMS TOTAL (/250)',
  ]);
  assert.equal(h.filter(header=>/Exam Max|Exam Points|Pending|Combined Exam %/.test(header)).length,0);
  assert.equal(ws.getRow(1).getCell(3).fill.fgColor.argb,'FF174EA6');
  assert.equal(ws.getRow(1).getCell(5).fill.fgColor.argb,'FF6D37AD');
  assert.equal(ws.getRow(1).getCell(8).fill.fgColor.argb,'FF00675D');
  assert.equal(ws.getRow(1).getCell(8).font.bold,true);
  assert.equal(ws.options.views[0].xSplit,2);
  assert.equal(ws.getRow(2).getCell(3).value,40);
  assert.equal(ws.getRow(2).getCell(5).value,0);
  assert.equal(ws.getRow(2).getCell(8).value.formula,'SUM(C2,D2,E2,F2)');
  assert.equal(ws.getRow(2).getCell(8).value.result,169);
  assert.equal(ws.getRow(3).getCell(3).value,0);
  assert.equal(ws.getRow(3).getCell(4).value,'');
  assert.equal(ws.getRow(3).getCell(4).fill.fgColor.argb,'FFFFF1C7');
  assert.equal(ws.getRow(3).getCell(8).value.result,0);
  assert.match(ws.getRow(3).getCell(8).note,/3 exam score/);
  assert.equal(ws.getRow(3).getCell(8).fill.fgColor.argb,'FFFFF1C7');
});

test('Exported subject/section sheets never mix class exam maxima',async()=>{
  const {workbook}=await setupExport();
  assert.equal(workbook.worksheets.length,2);  // no duplicate "Exam Totals" sheet
  assert.match(workbook.worksheets[0].name,/IT101 - A/);
  assert.match(workbook.worksheets[1].name,/IT101 - B/);
  assert.equal(workbook.worksheets[1].getRow(1).getCell(4).value,'EXAMS TOTAL (/200)');
  assert.equal(workbook.worksheets[1].getRow(2).getCell(4).value.result,190);
});

test('Combined exam score works without individual score columns',async()=>{
  const {workbook}=await setupExport({includeActivities:false,section:'A'});
  const ws=workbook.worksheets[0];
  assert.deepEqual(Array.from(ws.getRow(1).cells,c=>c.value),['Student No.','Student Name','EXAMS TOTAL (/250)']);
  assert.equal(ws.getRow(2).getCell(3).value,169);
});

test('When exam total checkbox is off no exam total column is added',async()=>{
  const {workbook}=await setupExport({includeExam:false,section:'A'});
  const headers=workbook.worksheets[0].getRow(1).cells.map(c=>c.value);
  assert.equal(headers.some(h=>h.includes('EXAMS TOTAL')),false);
});

test('CSV stays numeric and compact, with section columns to distinguish classes',async()=>{
  const {blob}=await setupExport({format:'csv',includeActivities:false});
  assert.ok(blob[0].startsWith('\uFEFF'));
  const lines=blob[0].slice(1).split('\r\n');
  assert.equal(lines.length,4);
  assert.ok(lines[0].includes('EXAMS TOTAL (max varies by class)'));
  assert.match(lines[1],/s1,Ana,A,IT101,169$/);
  assert.match(lines[3],/s2,Ben,A,IT101,0$/);
});
