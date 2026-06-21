import { Request, Response } from "express";
import prisma from "../prisma/client";

export const assignConversation = async (
  req: Request,
  res: Response
) => {
  try {
    const conversationId = Number(req.params.id);
    const { assignedToId } = req.body;

    if (!conversationId) {
      return res.status(400).json({
        message: "Invalid conversation id",
      });
    }

    const conversation =
      await prisma.conversation.findUnique({
        where: {
          id: conversationId,
        },
      });

    if (!conversation) {
      return res.status(404).json({
        message: "Conversation not found",
      });
    }

    // Optional: verify user exists
    if (assignedToId) {
      const user = await prisma.user.findUnique({
        where: {
          id: Number(assignedToId),
        },
      });

      if (!user) {
        return res.status(404).json({
          message: "User not found",
        });
      }
    }

    const updatedConversation =
      await prisma.conversation.update({
        where: {
          id: conversationId,
        },
        data: {
          assignedToId:
            assignedToId === null
              ? null
              : Number(assignedToId),
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

    return res.json({
      success: true,
      conversation: updatedConversation,
    });
  } catch (err) {
    console.error(
      "Assign conversation error:",
      err
    );

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};