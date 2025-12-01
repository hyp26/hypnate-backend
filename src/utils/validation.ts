import { z } from "zod";

export const productSchema = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  price: z.number().positive(),
  stock: z.number().int().nonnegative(),
  image: z.string().url(),
});
