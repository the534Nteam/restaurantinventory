// Security rules test. Run from this folder (needs Java + Node):
//   npm i firebase-tools@13 @firebase/rules-unit-testing@3 firebase@10
//   npx firebase emulators:exec --only firestore --project demo-pl "node rules.test.mjs"
import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import fs from 'fs';
const env=await initializeTestEnvironment({projectId:'demo-pl',firestore:{rules:fs.readFileSync('../firestore.rules','utf8'),host:'127.0.0.1',port:8080}});
let pass=0,fail=0; async function t(name,p){ try{ await p; pass++; console.log('ok  ',name);}catch(e){ fail++; console.log('FAIL',name,e.message);} }
const anonDb=env.unauthenticatedContext().firestore();
const sean=env.authenticatedContext('sean').firestore(), bad=env.authenticatedContext('bad').firestore(), joy=env.authenticatedContext('joy').firestore();
await t('no login: cannot read stores', assertFails(anonDb.doc('stores/_index').get()));
await t('no login: cannot set passcode', assertFails(anonDb.doc('settings/passcode').set({code:'123456'})));
await t('signed in, no passcode yet: cannot read stores', assertFails(sean.doc('stores/_index').get()));
await t('status readable', assertSucceeds(sean.doc('settings/status').get()));
await t('short passcode rejected', assertFails(sean.doc('settings/passcode').set({code:'1234'})));
const b=sean.batch(); b.set(sean.doc('settings/passcode'),{code:'246810'}); b.set(sean.doc('settings/status'),{passcodeSet:true});
await t('first passcode + status in one batch', assertSucceeds(b.commit()));
await t('second create of passcode blocked (bad user)', assertFails(bad.doc('settings/passcode').set({code:'999999'})));
await t('passcode not readable', assertFails(sean.doc('settings/passcode').get()));
await t('sean joins with right code', assertSucceeds(sean.doc('members/sean').set({code:'246810',name:'Sean'})));
await t('sean reads/writes store', assertSucceeds(sean.doc('stores/loc_moanalua').set({counts:{}})));
await t('sean writes history subdoc', assertSucceeds(sean.doc('stores/loc_moanalua/history/h1').set({ts:'2026'})));
await t('bad user wrong code', assertFails(bad.doc('members/bad').set({code:'111111'})));
await t('bad user cannot write someone else member doc', assertFails(bad.doc('members/joy').set({code:'246810'})));
await t('bad user extra fields rejected', assertFails(bad.doc('members/bad').set({code:'246810',admin:true})));
await t('bad user cannot read store', assertFails(bad.doc('stores/loc_moanalua').get()));
await t('bad user cannot change passcode', assertFails(bad.doc('settings/passcode').set({code:'000000'})));
await t('bad user cannot delete status', assertFails(bad.doc('settings/status').delete()));
await t('joy joins', assertSucceeds(joy.doc('members/joy').set({code:'246810',name:'Joy'})));
await t('sean changes passcode', assertSucceeds(sean.doc('settings/passcode').set({code:'135791'})));
await t('joy now locked out', assertFails(joy.doc('stores/loc_moanalua').get()));
await t('sean locked out until rejoin', assertFails(sean.doc('stores/loc_moanalua').get()));
await t('sean rejoins with new code', assertSucceeds(sean.doc('members/sean').set({code:'135791',name:'Sean'})));
await t('sean reads again', assertSucceeds(sean.doc('stores/loc_moanalua').get()));
await t('joy cannot rejoin with old code', assertFails(joy.doc('members/joy').set({code:'246810'})));
await env.cleanup(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
