import {z} from 'zod';
import type {DefinitionSnapshot} from './definitions.js';
export const StructureEndpointSchema=z.object({profileId:z.string().min(1).max(100),table:z.string().min(1).max(1000)}).strict();
export type StructureEndpoint=z.infer<typeof StructureEndpointSchema>;
const OverrideEntriesSchema=z.array(z.tuple([z.string().min(1).max(10000),z.string().trim().min(1).max(20000)])).max(256);
export const StructureColumnOverridesSchema=z.custom<Record<string,string>>(v=>v!==null&&typeof v==='object'&&!Array.isArray(v),'Column conversions must be a name/definition object.').transform((v,ctx)=>{const parsed=OverrideEntriesSchema.safeParse(Object.entries(v));if(!parsed.success){ctx.addIssue({code:z.ZodIssueCode.custom,message:'Use at most 256 named column definitions, each within the 20,000-character limit.'});return z.NEVER;}return Object.fromEntries(parsed.data) as Record<string,string>;});
export interface StructureDifference {id:string;kind:'column'|'constraint'|'index'|'order'|'options';objectKind?:string;name:string;change:'add'|'remove'|'change'|'equal';source?:string;target?:string;selectable:boolean;reason?:string;warnings?:string[];requiresReview?:boolean;}
export interface StructureComparison {token:string;source:DefinitionSnapshot;target:DefinitionSnapshot;capturedAt:string;expiresAt:string;differences:StructureDifference[];notes:string[];canPrepare:boolean;columnOverrides?:Record<string,string>;conversions?:{name:string;sql?:string;reason?:string;warnings:string[];manual:boolean}[];}
export interface PreparedStructureDraft {baseline:DefinitionSnapshot;sql:string;notes:string[];comparisonToken:string;}
