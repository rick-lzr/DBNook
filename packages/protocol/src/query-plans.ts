import type {ConnectionProfile,TransactionState} from './index.js';
export type PlanMode='explain'|'analyze';
export interface PlanNode{id:string;label:string;attributes:{name:string;value:string}[];children:PlanNode[];}
export interface PlanProposal{token:string;owner:string;profileId:string;connection:string;driver:ConnectionProfile['driver'];serverVersion:string;mode:PlanMode;sql:string;executedSql:string;format:'json'|'sqlite'|'text';transaction:TransactionState;context:{name:string;value:string}[];expiresAt:string;}
export interface QueryPlanReport extends PlanProposal{id:string;capturedAt:string;durationMs:number;transactionAfter:TransactionState;raw:string;nodes:PlanNode[];warnings:string[];truncated:boolean;}
