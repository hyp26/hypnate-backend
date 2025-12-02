import { Response } from "express";
import PDFDocument from "pdfkit";
import prisma from "../prisma/client";
import { AuthRequest } from "../middleware/authMiddleware";

export const generateInvoice = async (req: AuthRequest, res: Response) => {
  try {
    const orderId = parseInt(req.params.id);

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        products: {
          include: { Product: true },
        },
        Seller: true,
      }
    });

    if (!order) return res.status(404).json({ message: "Order not found" });

    const doc = new PDFDocument({ margin: 40 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=invoice-${order.id}.pdf`
    );

    doc.pipe(res);

    // Seller Info
    doc.fontSize(22).text(order.Seller.businessName);
    doc.fontSize(10);
    if (order.Seller.gstNumber) doc.text(`GST: ${order.Seller.gstNumber}`);
    if (order.Seller.phone) doc.text(`Phone: ${order.Seller.phone}`);
    doc.text(`Invoice Date: ${order.createdAt.toDateString()}`);
    doc.text(`Order ID: #${order.id}`);
    doc.moveDown();

    // Customer Section
    doc.fontSize(14).text("Bill To:", { underline: true });
    doc.fontSize(12);
    doc.text(order.customerName);
    if (order.customerEmail) doc.text(order.customerEmail);
    if (order.customerPhone) doc.text(order.customerPhone);
    if (order.shippingAddress) doc.text(order.shippingAddress);
    doc.moveDown();

    // Table Header
    doc.fontSize(14).text("Order Items", { underline: true }).moveDown(0.5);

    doc.fontSize(12);
    doc.text("Product", 40, doc.y, { continued: true });
    doc.text("Qty", 250, doc.y, { continued: true });
    doc.text("Price", 300, doc.y, { continued: true });
    doc.text("Subtotal", 400);
    doc.moveDown(0.5);

    // Divider
    doc.moveTo(40, doc.y).lineTo(550, doc.y).stroke().moveDown(0.5);

    // Items
    order.products.forEach((item) => {
      const price = item.priceAtPurchase || item.Product.price;
      const subtotal = price * item.quantity;

      doc.text(item.Product.name, 40, doc.y, { continued: true });
      doc.text(String(item.quantity), 250, doc.y, { continued: true });
      doc.text(`₹${price}`, 300, doc.y, { continued: true });
      doc.text(`₹${subtotal}`, 400);

      doc.moveDown(0.3);
    });

    doc.moveDown();

    // Totals
    doc.fontSize(12);
    doc.text(`Subtotal: ₹${order.subtotal}`, { align: "right" });
    doc.text(`Tax (GST): ₹${order.tax}`, { align: "right" });
    doc.fontSize(14).text(`Total: ₹${order.totalAmount}`, { align: "right" });
    doc.moveDown();

    // Payment
    if (order.paymentStatus) {
      doc.fontSize(12).text(`Payment Status: ${order.paymentStatus.toUpperCase()}`);
    }
    if (order.paymentMethod) {
      doc.text(`Payment Method: ${order.paymentMethod}`);
    }

    doc.moveDown(2);

    doc.fontSize(10).text("Thank you for your order!", { align: "center" });

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to generate invoice" });
  }
};
