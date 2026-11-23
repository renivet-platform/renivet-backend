import { OtpDeliveryMessage, OtpDeliveryPort } from './otp-delivery';
import { ResendFetch, ResendOtpDeliveryFailure } from './resend-template-otp-delivery';

interface Configuration {
  apiKey?: string;
  from?: string;
  onDeliveryFailure?: (failure: ResendOtpDeliveryFailure) => void;
}
const ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 5_000;
function clean(input: string | undefined) { return input?.trim() || undefined; }
function email(value: string | undefined): boolean {
  return Boolean(value && value.length<=254
    && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value));
}
function sender(value: string | undefined): boolean {
  if (!value || value.length>320 || /[\r\n]/.test(value)) return false;
  const parsed=/^(?:[^<>\r\n]{1,120}\s)?<([^<>\s]+)>$/.exec(value);
  return email(parsed?.[1]??value);
}
/** Purpose-bound OTP over Resend HTTPS, without SMTP ports or hosted templates. */
export class ResendDirectOtpDelivery implements OtpDeliveryPort {
  private readonly apiKey?: string;
  private readonly from?: string;
  private readonly onDeliveryFailure?: (failure: ResendOtpDeliveryFailure)=>void;
  constructor(configuration: Configuration,private readonly fetcher: ResendFetch=fetch) {
    this.apiKey=clean(configuration.apiKey);
    this.from=clean(configuration.from);
    this.onDeliveryFailure=configuration.onDeliveryFailure;
  }
  get available(): boolean { return Boolean(this.apiKey) && sender(this.from); }
  availableFor(channel: OtpDeliveryMessage['channel'],purpose: OtpDeliveryMessage['purpose']): boolean {
    return this.available && channel==='email' && (purpose==='email_verification'||purpose==='password_recovery');
  }
  private report(failure: ResendOtpDeliveryFailure) {
    try { this.onDeliveryFailure?.(failure); } catch { /* Diagnostics never expose private data. */ }
  }
  async send(message: OtpDeliveryMessage,signal?:AbortSignal):Promise<void> {
    if(!this.availableFor(message.channel,message.purpose)||!email(message.destination)
       || !/^[0-9]{6}$/.test(message.code)||!Number.isInteger(message.expiresInSeconds)
       ||message.expiresInSeconds<1||message.expiresInSeconds>3600||signal?.aborted)
      throw new Error('Email delivery failed.');
    const minutes=Math.ceil(message.expiresInSeconds/60);
    const subject=message.purpose==='email_verification'?'Your Renivet verification code':'Your Renivet password reset code';
    const action=message.purpose==='email_verification'?'verify your email':'reset your password';
    const controller=new AbortController();
    const cancel=()=>controller.abort();
    signal?.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(cancel,TIMEOUT_MS);
    let reported=false;
    const report=(failure:ResendOtpDeliveryFailure)=>{reported=true;this.report(failure);};
    try {
      const response=await this.fetcher(ENDPOINT,{
        method:'POST',
        headers:{authorization:`Bearer ${this.apiKey}`,'content-type':'application/json'},
        body:JSON.stringify({from:this.from,to:[message.destination],subject,
          text:`Use ${message.code} to ${action}. This code expires in ${minutes} minutes. If you did not request this, ignore this email.`,
          html:`<p>Use this one-time code to ${action}:</p><p><strong>${message.code}</strong></p><p>Expires in ${minutes} minutes.</p>`,
        }),signal:controller.signal,
      });
      if(!response.ok){
        const failure:ResendOtpDeliveryFailure={provider:'resend',kind:'http_error',status:response.status};
        try{const body:unknown=await response.json();
          if(body&&typeof body==='object'&&'name' in body&&typeof body.name==='string'
            &&/^[a-z0-9_-]{1,64}$/i.test(body.name))failure.code=body.name;
        }catch{ /* Preserve the HTTP status without retaining provider details. */ }
        report(failure);throw new Error('provider rejected');
      }
      const result:unknown=await response.json().catch(()=>null);
      if(!result||typeof result!=='object'||!('id' in result)||typeof result.id!=='string'||!result.id)
        {report({provider:'resend',kind:'invalid_response',status:response.status});throw new Error('invalid response');}
    }catch{
      if(!reported&&!signal?.aborted)report({provider:'resend',kind:'network_error'});
      throw new Error('Email delivery failed.');
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
  }
}
