import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from "path";
import productRoutes from './routes/product.routes';
import uploadRoutes from "./routes/upload.routes";
import orderRoutes from './routes/order.routes';
import authRoutes from './routes/auth.routes';
import analyticsRoutes from './routes/analytics.routes';
import errorHandler from './middleware/errorHandler';


console.log("App starting...");


dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/products', productRoutes);
app.use("/api/products/upload", uploadRoutes);
app.use("/uploads", express.static(path.join(__dirname, "../uploads")))
app.use('/api/orders', orderRoutes);
app.use('/api/auth', authRoutes);
app.use("/api/analytics", analyticsRoutes);

app.get("/api/health", (_, res) => res.json({ status: "ok" }));

app.use(errorHandler);

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

