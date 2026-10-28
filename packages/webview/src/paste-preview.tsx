import React,{useEffect,useRef} from 'react';
import {displayCell,type CellValue} from '../../protocol/src/index.js';
import './paste-preview.css';
export interface PasteChange {row:string;column:string;before:CellValue;after:CellValue;}
const show=(value:CellValue)=>typeof value==='string'?JSON.stringify(value):displayCell(value);
export function PastePreview({changes,cancel,apply}:{changes:PasteChange[];cancel():void;apply():void}){
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{dialog.current?.showModal();},[]);
 return <dialog ref={dialog} className="paste-preview" aria-labelledby="paste-title" onCancel={event=>{event.preventDefault();cancel();}}>
  <h2 id="paste-title">Preview paste · {changes.length} cells</h2>
  <p>Apply to the current draft, then Save to write to the database. Unquoted \N means NULL; quoted empty text means an empty string.</p>
  <div className="paste-scroll"><table><thead><tr><th>Row</th><th>Column</th><th>Before</th><th>After</th></tr></thead><tbody>{changes.map((c,i)=><tr key={i}><td>{c.row}</td><td>{c.column}</td><td><code>{show(c.before)}</code></td><td><code>{show(c.after)}</code></td></tr>)}</tbody></table></div>
  <div className="paste-actions"><button autoFocus className="secondary" onClick={cancel}>Cancel paste</button><button onClick={apply}>Apply to draft</button></div>
 </dialog>;
}
