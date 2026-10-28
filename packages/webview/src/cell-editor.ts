import type {ICellEditorComp,ICellEditorParams} from 'ag-grid-community';
import {editableCell,type CellValue} from '../../protocol/src/index.js';

/** Display markers (NULL, BLOB labels) must never become an edit's raw value. */
export class RawCellEditor implements ICellEditorComp {
 private input=document.createElement('input');
 private original:CellValue|undefined;
 private changed=false;
 private markChanged=()=>{this.changed=true;};
 init(params:ICellEditorParams):void{
  this.original=params.value as CellValue|undefined;
  this.input.className='ag-input-field-input ag-text-field-input';
  this.input.setAttribute('aria-label','Input Editor');
  this.input.value=editableCell(this.original);
  if(this.original===null)this.input.placeholder='NULL';
  this.input.addEventListener('input',this.markChanged);
 }
 getGui():HTMLElement{return this.input;}
 afterGuiAttached():void{this.input.focus();this.input.select();}
 getValue():CellValue|string|undefined{return this.changed?this.input.value:this.original;}
 destroy():void{this.input.removeEventListener('input',this.markChanged);}
}
