import {z} from 'zod';
import type {CellValue,ColumnMeta,DataRow} from './index.js';
export const CompareSourceSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('table'),profileId:z.string().min(1).max(100),table:z.string().min(1).max(1000)}).strict(),
  z.object({kind:z.literal('result'),id:z.string().uuid()}).strict(),
]);
export type CompareSource=z.infer<typeof CompareSourceSchema>;
export const ComparePairSchema=z.object({source:z.string().min(1).max(1000),target:z.string().min(1).max(1000),key:z.boolean(),mode:z.enum(['strict','numeric','boolean']).default('strict')}).strict();
export type ComparePair=z.infer<typeof ComparePairSchema>;
export const CompareInputSchema=z.object({source:CompareSourceSchema,target:CompareSourceSchema,pairs:z.array(ComparePairSchema).min(1).max(1000),limit:z.number().int().min(1).max(100000).default(10000)}).strict();
export type CompareInput=z.infer<typeof CompareInputSchema>;
export interface CompareDatasetInfo {label:string;source:CompareSource;profileId:string;columns:ColumnMeta[];rows:number;truncated:boolean;bytes:number;capturedAt:string;writable:boolean;}
export interface CompareRow {id:string;kind:'source-only'|'target-only'|'changed'|'equal';source?:DataRow;target?:DataRow;changed:string[];}
export interface CompareSummary {token:string;input:CompareInput;source:CompareDatasetInfo;target:CompareDatasetInfo;counts:Record<CompareRow['kind'],number>;expiresAt:string;warnings:string[];canSync:boolean;syncReason?:string;}
export interface ComparePage {rows:CompareRow[];total:number;offset:number;}
export interface SyncPreview {token:string;comparison:string;target:string;inserted:number;updated:number;deleted:number;steps:number;sql:string;scriptTruncated:boolean;expiresAt:string;}
export interface SyncReport {status:'succeeded'|'failed'|'cancelled'|'unknown';affectedRows:number;committed:boolean;error?:string;warnings:string[];}
export interface CompareCatalog {profiles:{id:string;name:string;driver:string}[];results:{id:string;label:string;rows:number;truncated:boolean}[];}
export interface CompareCellDiff {source?:CellValue;target?:CellValue;}
