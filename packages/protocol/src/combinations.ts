import {z} from 'zod';
import {CompareSourceSchema} from './comparisons.js';
import type {ColumnMeta,DataRow} from './index.js';
export const CombinationSourceSchema=z.union([CompareSourceSchema,z.object({kind:z.literal('derived'),id:z.string().uuid()}).strict()]);
export type CombinationSource=z.infer<typeof CombinationSourceSchema>;
export const JoinPairSchema=z.object({left:z.string().min(1).max(1000),right:z.string().min(1).max(1000),mode:z.enum(['text','strict','numeric','boolean']).default('text')}).strict();
export const CombinationInputSchema=z.discriminatedUnion('operation',[
  z.object({operation:z.literal('join'),sources:z.array(CombinationSourceSchema).length(2),type:z.enum(['inner','left','right','full','cross']),pairs:z.array(JoinPairSchema).max(1000),keepRightKeys:z.boolean().default(false),limit:z.number().int().min(1).max(100000).default(10000)}).strict(),
  z.object({operation:z.literal('union'),sources:z.array(CombinationSourceSchema).min(2).max(20),limit:z.number().int().min(1).max(100000).default(10000)}).strict(),
]);
export type CombinationInput=z.infer<typeof CombinationInputSchema>;
export interface CombinationColumn extends ColumnMeta {origins:{node:string;column:string}[];}
export interface CombinationNode {id:string;label:string;kind:'table'|'result'|'join'|'union';parents:string[];capturedAt:string;rows:number;truncated:boolean;profileId?:string;target?:Record<string,string|number|undefined>;targetRevision?:string;sql?:string;recipe?:CombinationInput;}
export interface CombinationSummary {id:string;label:string;operation:'join'|'union';columns:CombinationColumn[];rows:number;bytes:number;inputTruncated:boolean;outputTruncated:boolean;truncated:boolean;sources:{label:string;rows:number;truncated:boolean;capturedAt:string}[];warnings:string[];expiresAt:string;}
export interface CombinationPage {columns:CombinationColumn[];columnOffset:number;columnCount:number;rows:DataRow[];offset:number;total:number;abbreviated:boolean;}
