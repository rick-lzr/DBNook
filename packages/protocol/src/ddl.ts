import {z} from 'zod';
const name=z.string().min(1).max(255).refine(v=>!v.includes('\0'),'Names cannot contain NUL.');
const fragment=z.string().trim().min(1).max(20000);
export const DdlColumnSchema=z.object({name,dataType:fragment,nullable:z.boolean().default(true),defaultSql:fragment.nullable().default(null)}).strict();
export const DdlConstraintSchema=z.object({name,kind:z.enum(['primary','unique','foreign','check']),columns:z.array(name).max(64).default([]),expression:fragment.optional(),targetSchema:name.optional(),targetTable:name.optional(),targetColumns:z.array(name).max(64).optional(),onDelete:z.enum(['NO ACTION','RESTRICT','CASCADE','SET NULL','SET DEFAULT']).default('NO ACTION'),onUpdate:z.enum(['NO ACTION','RESTRICT','CASCADE','SET NULL','SET DEFAULT']).default('NO ACTION')}).strict();
export const DdlIntentSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('createTable'),schema:name.optional(),name,columns:z.array(DdlColumnSchema).min(1).max(256),constraints:z.array(DdlConstraintSchema).max(64).default([])}).strict(),
  z.object({action:z.literal('addColumn'),column:DdlColumnSchema}).strict(),
  z.object({action:z.literal('alterColumn'),column:name,change:z.enum(['type','default','nullable']),value:z.union([fragment,z.boolean(),z.null()])}).strict(),
  z.object({action:z.literal('renameColumn'),column:name,name}).strict(),
  z.object({action:z.literal('dropColumn'),column:name}).strict(),
  z.object({action:z.literal('addIndex'),name,unique:z.boolean().default(false),columns:z.array(z.object({name,direction:z.enum(['asc','desc']).default('asc')}).strict()).min(1).max(64),where:fragment.optional()}).strict(),
  z.object({action:z.literal('dropIndex'),name}).strict(),
  z.object({action:z.literal('addConstraint'),constraint:DdlConstraintSchema}).strict(),
  z.object({action:z.literal('dropConstraint'),name}).strict(),
  z.object({action:z.literal('renameTable'),name}).strict(),
  z.object({action:z.literal('dropTable')}).strict(),
  z.object({action:z.literal('editDefinition'),sql:z.string().min(1).max(4*1024*1024),baselineSql:z.string().max(4*1024*1024).optional(),renames:z.array(z.object({from:name,to:name}).strict()).max(256).default([])}).strict(),
]);
export type DdlIntent=z.infer<typeof DdlIntentSchema>;
export type DdlColumn=z.infer<typeof DdlColumnSchema>;
export type DdlConstraint=z.infer<typeof DdlConstraintSchema>;
const metadataName=z.string().min(1).max(10000),metadataSql=z.string().max(4*1024*1024);
export const TableStructureSchema=z.object({sqlMode:z.object({noBackslashEscapes:z.boolean(),ansiQuotes:z.boolean(),mariaDb:z.boolean().optional()}).strict().optional(),
  name:metadataName,schema:metadataName.optional(),label:metadataName,type:z.enum(['table','view']),identity:z.string().max(8*1024*1024),definition:metadataSql,notes:z.array(z.string().max(20000)).max(100),editable:z.boolean(),
  columns:z.array(z.object({name:metadataName,dataType:z.string().max(20000),nullable:z.boolean(),defaultSql:metadataSql.nullable(),generated:z.boolean(),primaryKey:z.number(),definition:metadataSql}).strict()).max(4096),
  indexes:z.array(z.object({name:metadataName,unique:z.boolean(),columns:z.array(metadataName),definition:metadataSql,protected:z.boolean(),comment:metadataSql.nullable().optional(),replicaIdentity:z.boolean().optional(),clustered:z.boolean().optional()}).strict()).max(10000),
  constraints:z.array(z.object({name:metadataName,kind:z.string().max(100),definition:metadataSql,comment:metadataSql.nullable().optional()}).strict()).max(10000),
  auxiliary:z.array(z.object({type:z.string().max(100),name:metadataName,sql:metadataSql}).strict()).max(10000),
}).strict();
export type TableStructure=z.infer<typeof TableStructureSchema>;
export interface DdlStep{sql:string;expect?:'empty'|'one'|'integrity';}
export interface DdlPreview{token:string;profileId:string;table:string;intent:DdlIntent;before:string;steps:DdlStep[];warnings:string[];policy:'transactional'|'sqlite-rebuild'|'implicit-commit';expiresAt:string;}
export interface DdlReport{status:'succeeded'|'failed'|'cancelled'|'unknown';completed:number;rolledBack:boolean;committed?:boolean;warnings?:string[];error?:string;table:string;removed?:boolean;}
