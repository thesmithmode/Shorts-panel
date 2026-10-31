import {test} from 'node:test';
import assert from 'node:assert/strict';
import {releaseIdentity} from '../src/server/health.ts';
test('health identifies exact release and rejects malformed release metadata',()=>{
 assert.equal(releaseIdentity(undefined),'development');
 assert.equal(releaseIdentity('a'.repeat(40)+'\n'),'a'.repeat(40));
 for(const value of ['main','a'.repeat(39),'../../etc/passwd',''])assert.throws(()=>releaseIdentity(value));
});
