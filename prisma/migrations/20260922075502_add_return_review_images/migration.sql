-- CreateTable
CREATE TABLE "return_review_images" (
    "id" TEXT NOT NULL,
    "returnReviewId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "return_review_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "return_review_images_returnReviewId_idx" ON "return_review_images"("returnReviewId");

-- AddForeignKey
ALTER TABLE "return_review_images" ADD CONSTRAINT "return_review_images_returnReviewId_fkey" FOREIGN KEY ("returnReviewId") REFERENCES "return_reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
