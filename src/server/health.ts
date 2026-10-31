/** A deployed process must identify the immutable release, not merely return 200. */
export function releaseIdentity(value:string|undefined):string {
  if(value===undefined)return 'development';
  const sha=value.trim();
  if(!/^[0-9a-f]{40}$/.test(sha))throw new Error('Invalid release identity');
  return sha;
}
