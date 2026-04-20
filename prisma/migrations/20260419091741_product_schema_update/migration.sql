/*
  Warnings:

  - You are about to alter the column `price` on the `products` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(10,2)`.
  - Added the required column `updated_at` to the `products` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "products" ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "price" SET DATA TYPE DECIMAL(10,2);

-- CreateIndex
CREATE INDEX "products_category_is_active_idx" ON "products"("category", "is_active");
