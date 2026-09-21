import { Request, Response, NextFunction } from "express";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";
import { getPlanAccess, 
    createSubscriptionForSeller, 
    verifySubscriptionSignature, 
    verifyWebhookSignature, 
    activatePaidPlanFromSubscription, 
    clearPaidPlanFromSubscription
 } from "../services/billing.service";
import { normalizeBillingCycle, normalizePlan } from "../config/planEntitlements";

// get the billing status of the seller, including their selected plan, trial status, and active plan details
export const getBillingStatus = async (
    req: AuthRequest, 
    res: Response, 
    next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId; 
    
    if (!sellerId) return res.status(403).json
    ({ 
        message: "Seller account required" 
    });
    const seller = await prisma.seller.findUnique
    ({ 
        where: { id: sellerId } 
    }); 
    
    if (!seller) return res.status(404).json
    ({ 
        message: "Seller not found" 
    });

    const access = getPlanAccess(seller);
    return res.json
    
    ({ 
        access, 
        selectedPlan: seller.selectedPlan, 
        trialPlan: seller.trialPlan, 
        trialStartedAt: seller.trialStartedAt, 
        trialEndsAt: seller.trialEndsAt, 
        activePlan: seller.activePlan,
        planStatus: seller.planStatus, 
        planActivatedAt: seller.planActivatedAt, 
        planCurrentPeriodEnd: seller.planCurrentPeriodEnd, 
        billingCycle: seller.billingCycle, 
        razorpaySubscriptionId: seller.razorpaySubscriptionId 
    });
  } 
  catch (e) 
  { 
    next(e);
 }
};

// create a new subscription for the seller based on the selected plan and billing cycle
export const createBillingSubscription = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const authUser = req.user;

    if (!authUser?.sellerId) {
      return res.status(403).json({
        message: "Seller account required",
      });
    }

    const sellerId = authUser.sellerId;

    const plan = normalizePlan(req.body?.plan);
    const cycle = normalizeBillingCycle(req.body?.billingCycle);

    if (!plan || !cycle) {
      return res.status(400).json({
        message: "Valid plan and billing cycle are required",
      });
    }

    const [seller, user] = await Promise.all([
      prisma.seller.findUnique({
        where: { id: sellerId },
        select: { phone: true },
      }),
      prisma.user.findUnique({
        where: { id: authUser.id },
        select: { name: true, email: true },
      }),
    ]);

    if (!seller || !user) return res.status(404).json({ 
        message: "Account not found" 
    });
    
    const result = await createSubscriptionForSeller({ 
        sellerId, 
        planValue: plan, 
        cycleValue: cycle, 
        customer: {
             name: user.name, 
             email: user.email, 
             contact: seller.phone || undefined 
            } 
        });

    return res.status(201).json(result);
  } 
  catch (e) 
  { 
    next(e); 
}
};

// verify the payment and subscription details sent by Razorpay after a successful payment
export const verifyBillingPayment = async (
    req: AuthRequest, 
    res: Response, 
    next: NextFunction
) => {
  try {
    const sellerId = req.user?.sellerId; 
    
    if (!sellerId) return res.status(403).json({ message: "Seller account required" });

    const { razorpay_payment_id: paymentId, 
            razorpay_subscription_id: subscriptionId, 
            razorpay_signature: signature } = req.body || {};

    if (!paymentId || !subscriptionId || !signature) 
        return res.status(400).json({ message: "Razorpay verification data is incomplete" });

    const seller = await prisma.seller.findUnique({ where: { id: sellerId } });

    if (!seller || seller.razorpaySubscriptionId !== subscriptionId) 
        return res.status(403).json({ message: "Subscription does not belong to this account" });

    if (!verifySubscriptionSignature({ 
        subscriptionId, 
        paymentId, 
        signature 
    })
    ) 
    
    return res.status(400).json({ 
        message: "Invalid Razorpay signature" 
    });

    const activation = await activatePaidPlanFromSubscription(subscriptionId);
    return res.json({ verified: true, activation });
  } 
  catch (e) 
  { 
    next(e); 
}
};

// handle Razorpay webhook events for subscription updates and plan changes
export const razorpayWebhook = async (
    req: Request, 
    res: Response, 
    next: NextFunction
  ) => {
  try {
    const signature = req.get("x-razorpay-signature"); 
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

    if (!signature || !rawBody || !verifyWebhookSignature(rawBody, signature)) 
      return res.status(400).json({ message: "Invalid webhook signature" });

    const event = String(req.body?.event || ""); 
    const subscriptionId = req.body?.payload?.subscription?.entity?.id;

    if (!subscriptionId) return res.status(200).json({ received: true });

    if ([
      "subscription.activated", 
      "subscription.charged", 
      "subscription.resumed"
    ]
    .includes(event)) 
      await activatePaidPlanFromSubscription(subscriptionId);

    else if (event === "subscription.pending") 
      await prisma.seller.updateMany
    ({ 
      where: { 
        razorpaySubscriptionId: subscriptionId }, 
        data: { planStatus: "PENDING" } 
      });

    else if ([
      "subscription.cancelled", 
      "subscription.halted", 
      "subscription.completed", 
      "subscription.expired"
    ]
    .includes(event)) 
      await clearPaidPlanFromSubscription(
        subscriptionId, event.split(".")[1] || "CANCELLED"
      );

    return res.status(200).json
    ({ 
      received: true 
    });
  } 
  catch (e) 
  { 
    next(e); 
  }
};
