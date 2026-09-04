import { Request, Response } from "express";
import prisma from "../prisma/client";
import { getSellerId } from "../services/seller.service";
import { logger } from "../utils/logger";

export const assignConversation = async (
  req: Request,
  res: Response
) => {
  try {
    const sellerId = await getSellerId(req);

    if (!sellerId) {
      return res.status(401).json({
        message: "Unauthorized",
      });
    }

    const conversationId = Number(req.params.id);
    const { assignedToId } = req.body;

    if (
      !Number.isInteger(conversationId) ||
      conversationId <= 0
    ) {
      return res.status(400).json({
        message: "Invalid conversation id",
      });
    }

    // Validate assignedToId when assigning.
    let normalizedAssignedToId: number | null = null;

    if (assignedToId !== null && assignedToId !== undefined) {
      normalizedAssignedToId = Number(assignedToId);

      if (
        !Number.isInteger(normalizedAssignedToId) ||
        normalizedAssignedToId <= 0
      ) {
        return res.status(400).json({
          message: "Invalid assigned user id",
        });
      }
    }

    // CRITICAL TENANT CHECK:
    // The conversation must belong to the authenticated seller.
    const conversation =
      await prisma.conversation.findFirst({
        where: {
          id: conversationId,
          sellerId,
        },
      });

    if (!conversation) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    // If assigning the conversation to a user, that user must
    // belong to the SAME seller.
    if (normalizedAssignedToId !== null) {
      const user = await prisma.user.findFirst({
        where: {
          id: normalizedAssignedToId,
          sellerId,
        },

        select: {
          id: true,
        },
      });

      if (!user) {
        return res.status(404).json({
          message: "User not found",
        });
      }
    }

    // Keep sellerId in the update condition as defense-in-depth.
    const updateResult =
      await prisma.conversation.updateMany({
        where: {
          id: conversationId,
          sellerId,
        },

        data: {
          assignedToId: normalizedAssignedToId,
        },
      });

    if (updateResult.count !== 1) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    const updatedConversation =
      await prisma.conversation.findFirst({
        where: {
          id: conversationId,
          sellerId,
        },

        include: {
          assignedTo: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      });

    if (!updatedConversation) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    const io = req.app.get("io");

    // Never broadcast assignment changes to every tenant.
    if (io) {
      io.to(`seller_${sellerId}`).emit(
        "conversation_updated",
        {
          conversationId: updatedConversation.id,
          conversation: updatedConversation,
        }
      );
    }

    return res.json({
      success: true,
      conversation: updatedConversation,
    });
  } catch (err) {
    logger.error("Conversation assignment failed", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};