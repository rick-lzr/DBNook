export interface SettingWrite { scope: 'global'|'workspace'; before: unknown; after: unknown; }
/** Compensates settings writes if moving between scopes fails partway through. */
export async function commitProfileSettings(writes: SettingWrite[], update: (scope: SettingWrite['scope'], value: unknown) => PromiseLike<void>): Promise<void> {
  const attempted: SettingWrite[]=[];
  try { for(const item of writes){attempted.push(item);await update(item.scope,item.after);} }
  catch(error) {
    let failed=false;
    for(const item of attempted.reverse())try{await update(item.scope,item.before);}catch{failed=true;}
    if(failed)throw new Error('Connection settings could not be saved and restoring earlier settings was incomplete. Review both global and workspace connections before retrying.');
    throw error;
  }
}
