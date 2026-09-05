import { Request, Response } from "express";
import PDFDocument from "pdfkit";
import prisma from "../prisma/client";
import { logger } from "../utils/logger";

interface AuthenticatedRequest extends Request {
  user?: {
    id: number;
    sellerId?: number;
    role?: string;
  };
}

/**
 * Generate an invoice for an order.
 *
 * Authentication is handled by verifyToken in order.routes.ts.
 * The controller only uses the authenticated seller context and
 * verifies that the requested order belongs to that seller.
 */
export const generateInvoice = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const orderId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({
        message: "Invalid order ID",
      });
    }

    // -----------------------------------------
    // 1. AUTHENTICATED SELLER
    // -----------------------------------------

    const sellerId = req.user?.sellerId;

    if (!sellerId) {
      return res.status(403).json({
        message: "Seller context missing",
      });
    }

    // -----------------------------------------
    // 2. FETCH ORDER
    //    Ensure seller owns the order
    // -----------------------------------------

    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        sellerId,
      },
      include: {
        products: {
          include: {
            product: true,
          },
        },
        seller: true,
      },
    });

    if (!order) {
      return res.status(404).json({
        message: "Order not found",
      });
    }

    // -----------------------------------------
    // 3. START PDF DOCUMENT
    // -----------------------------------------

    const doc = new PDFDocument({
      margin: 40,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=invoice-${order.id}.pdf`
    );

    doc.pipe(res);

    // -----------------------------------------
    // 4. SELLER INFO
    // -----------------------------------------

    doc.fontSize(22).text(order.seller.businessName);
    doc.fontSize(10);

    if (order.seller.gstNumber) {
      doc.text(`GST: ${order.seller.gstNumber}`);
    }

    if (order.seller.phone) {
      doc.text(`Phone: ${order.seller.phone}`);
    }

    doc.text(`Invoice Date: ${order.createdAt.toDateString()}`);
    doc.text(`Order ID: #${order.id}`);
    doc.moveDown();

    // -----------------------------------------
    // 5. CUSTOMER DETAILS
    // -----------------------------------------

    doc.fontSize(14).text("Bill To:", {
      underline: true,
    });

    doc.fontSize(12);

    doc.text(order.customerName);

    if (order.customerEmail) {
      doc.text(order.customerEmail);
    }

    if (order.customerPhone) {
      doc.text(order.customerPhone);
    }

    if (order.shippingAddress) {
      doc.text(order.shippingAddress);
    }

    doc.moveDown();

    // -----------------------------------------
    // 6. TABLE HEADER
    // -----------------------------------------

    doc
      .fontSize(14)
      .text("Order Items", {
        underline: true,
      })
      .moveDown(0.5);

    doc.fontSize(12);

    doc.text("Product", 40, doc.y, {
      continued: true,
    });

    doc.text("Qty", 250, doc.y, {
      continued: true,
    });

    doc.text("Price", 300, doc.y, {
      continued: true,
    });

    doc.text("Subtotal", 400);

    doc.moveDown(0.5);

    doc
      .moveTo(40, doc.y)
      .lineTo(550, doc.y)
      .stroke()
      .moveDown(0.5);

    // -----------------------------------------
    // 7. ITEMS
    // -----------------------------------------

    order.products.forEach((item) => {
      const price = item.priceAtPurchase ?? item.product.price;
      const subtotal = price * item.quantity;

      doc.text(item.product.name, 40, doc.y, {
        continued: true,
      });

      doc.text(String(item.quantity), 250, doc.y, {
        continued: true,
      });

      doc.text(`₹${price}`, 300, doc.y, {
        continued: true,
      });

      doc.text(`₹${subtotal}`, 400);

      doc.moveDown(0.3);
    });

    doc.moveDown();

    // -----------------------------------------
    // 8. TOTALS
    // -----------------------------------------

    doc.fontSize(12);

    doc.text(`Subtotal: ₹${order.subtotal}`, {
      align: "right",
    });

    doc.text(`Tax (GST): ₹${order.tax}`, {
      align: "right",
    });

    doc.fontSize(14).text(`Total: ₹${order.totalAmount}`, {
      align: "right",
    });

    doc.moveDown();

    // -----------------------------------------
    // 9. PAYMENT DETAILS
    // -----------------------------------------

    if (order.paymentStatus) {
      doc
        .fontSize(12)
        .text(
          `Payment Status: ${order.paymentStatus.toUpperCase()}`
        );
    }

    if (order.paymentMethod) {
      doc.text(`Payment Method: ${order.paymentMethod}`);
    }

    doc.moveDown(2);

    // -----------------------------------------
    // 10. FOOTER
    // -----------------------------------------

    doc.fontSize(10).text("Thank you for your order!", {
      align: "center",
    });

    doc.end();
  } catch (err) {
    logger.error("Failed to generate invoice", err);

    if (!res.headersSent) {
      return res.status(500).json({
        message: "Failed to generate invoice",
      });
    }

    res.end();
  }
};