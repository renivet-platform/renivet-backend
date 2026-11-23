'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const { ResendDirectOtpDelivery }=require('../dist/modules/identity/resend-direct-otp-delivery');
const { createEmailOtpDelivery }=require('../dist/modules/identity/email-otp-delivery');

const config={apiKey:'re_synthetic_only',from:'Renivet <no-reply@example.test>'};
const message={channel:'email',purpose:'email_verification',destination:'buyer@example.test',code:'123456',expiresInSeconds:300};
test('HTTPS OTP sends purpose bound code, no SMTP and no template requirement',async()=>{
  let captured;
  const delivery=new ResendDirectOtpDelivery(config,async(url,init)=>{
    captured={url,init};
    return new Response(JSON.stringify({id:'email_synthetic'}),{status:200});
  });
  await delivery.send(message);
  assert.equal(captured.url,'https://api.resend.com/emails');
  const payload=JSON.parse(captured.init.body);
  assert.equal(payload.to[0],message.destination);
  assert.match(payload.text,/123456/);
  assert.ok(!('template' in payload));
  assert.equal(delivery.availableFor('email','password_recovery'),true);
  assert.equal(delivery.availableFor('phone','phone_login'),false);
});
test('HTTPS OTP keeps provider errors and credentials out of public error',async()=>{
  const failures=[];
  const delivery=new ResendDirectOtpDelivery({...config,onDeliveryFailure:f=>failures.push(f)},async()=>new Response(JSON.stringify({name:'validation_error',message:'private'}),{status:422}));
  await assert.rejects(delivery.send(message),error=>error.message==='Email delivery failed.'&&!error.cause);
  assert.deepEqual(failures,[{provider:'resend',kind:'http_error',status:422,code:'validation_error'}]);
});
test('HTTPS OTP factory selects direct provider with existing Resend SMTP key as fallback',()=>{
  const adapter=createEmailOtpDelivery({provider:'resend_direct',smtpHost:'smtp.resend.com',
    smtpPassword:'re_test_key',smtpFrom:'no-reply@example.test'});
  assert.equal(adapter.available,true);
});
test('invalid input and missing credentials fail without a network call',async()=>{
  let called=false;
  const delivery=new ResendDirectOtpDelivery(config,async()=>{called=true;throw Error('no network');});
  await assert.rejects(delivery.send({...message,code:'bad'}),/Email delivery failed/);
  assert.equal(called,false);
  assert.equal(new ResendDirectOtpDelivery({from:config.from}).available,false);
});
