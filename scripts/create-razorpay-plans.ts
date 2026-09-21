import "dotenv/config";
const keyId=process.env.RAZORPAY_KEY_ID; 
    const keySecret=process.env.RAZORPAY_KEY_SECRET; 
        if(!keyId||!keySecret) throw new Error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required");

const plans=[
["STARTER_MONTHLY","Hypnate Starter Monthly",99900,"monthly"],
["PRO_MONTHLY","Hypnate Pro Monthly",199900,"monthly"],
["BUSINESS_MONTHLY","Hypnate Business Monthly",500000,"monthly"],
["STARTER_YEARLY","Hypnate Starter Yearly",958800,"yearly"],
["PRO_YEARLY","Hypnate Pro Yearly",1918800,"yearly"],
["BUSINESS_YEARLY","Hypnate Business Yearly",4798800,"yearly"]] as const;

const auth=Buffer.from(`${keyId}:${keySecret}`).toString("base64");
(async()=>{for(const [env,name,amount,period] of plans){
    const r=await fetch("https://api.razorpay.com/v1/plans",{
        method:"POST",headers:{"Content-Type":"application/json",Authorization:`Basic ${auth}`},
        body:JSON.stringify({period,interval:1,item:{name,amount,currency:"INR",description:"Hypnate SaaS subscription"},
            notes:{product:"hypnate",plan:env.toLowerCase()

            }}
        )
    });
            const b=await r.json();if(!r.ok)throw new Error(`${env}: ${b?.error?.description||r.statusText}`);
            console.log(`RAZORPAY_PLAN_${env}=${b.id}`)}})();
