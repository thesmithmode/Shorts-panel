import {test} from 'node:test';
import assert from 'node:assert/strict';
import {groupDeliveries} from '../src/shared/deliveries.ts';
import type {Delivery} from '../src/shared/model.ts';
test('groups platform deliveries by video without losing order or mutating input',()=>{
 const make=(videoId:string,platform:Delivery['platform']):Delivery=>({videoId,platform,state:'pending',originalAt:0,nextAt:0,successAt:null,externalId:null,url:null,error:null,attempts:0});
 const input=[make('a','youtube'),make('b','instagram'),make('a','tiktok')];
 const result=groupDeliveries(input);
 assert.deepEqual([...result.keys()],['a','b']);assert.deepEqual(result.get('a'),[input[0],input[2]]);assert.deepEqual(result.get('b'),[input[1]]);assert.equal(groupDeliveries([]).size,0);assert.equal(input.length,3);
});
