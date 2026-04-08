import { Request, Response } from "express";
import prisma from "../prisma/client";

export const joinWaitlist = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ error: "Email is required" });
      return;
    }

    try {
      const existing = await prisma.waitlistSubscriber.findUnique({ where: { email } });
      if (existing) {
        res.status(400).json({ error: "Email is already on the waitlist" });
        return;
      }
      
      await prisma.waitlistSubscriber.create({
        data: { email }
      });
      console.log(`[Waitlist] New subscriber: ${email}`);
      res.status(201).json({ success: true, message: "Joined waitlist successfully" });
    } catch (dbError: any) {
      if (dbError.code === "P2002") {
        res.status(400).json({ error: "Email is already on the waitlist" });
        return;
      }
      throw dbError;
    }
  } catch (error) {
    console.error("Waitlist error:", error);
    res.status(500).json({ error: "Failed to join waitlist" });
  }
};
