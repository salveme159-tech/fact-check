import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "./_core/trpc";
import { factCheckArticle } from "./dart/articleFactCheck";
import { validateDartKey } from "./dart/client";

// 운영 환경에서는 사용자가 본인의 OpenDART 40자리 키를 보낸 요청만 처리합니다(서버 키 무단 사용 방지).
function requireDartKey(ctx: { req: { header: (name: string) => string | undefined } }) {
  const requestKey = ctx.req.header("x-opendart-key")?.trim();
  if (process.env.NODE_ENV === "production" && (!requestKey || !/^[A-Za-z0-9]{40}$/.test(requestKey) || /^(DEMO|VERIFIED)/i.test(requestKey))) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "실시간 DART 조회에는 본인이 발급받은 40자리 인증키가 필요합니다." });
  }
  return requestKey;
}

export const appRouter = router({
  dart: router({
    articleFactCheck: publicProcedure.input(z.object({
      article: z.string().min(10).max(30000),
      company: z.string().min(2).max(100).optional(),
      year: z.number().int().min(2015).max(2100).optional(),
      period: z.enum(["annual", "half", "q1", "q3"]).optional(),
      mode: z.enum(["cum", "qtr"]).optional(),
      basis: z.enum(["CFS", "OFS"]).optional(),
      articleDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, "올바른 기사 기준일을 입력하세요.").optional(),
      contractReceipt: z.string().regex(/^\d{14}$/).optional(),
    })).mutation(({ input, ctx }) => factCheckArticle(input, requireDartKey(ctx))),
    validateKey: publicProcedure.query(({ ctx }) => validateDartKey(ctx.req.header("x-opendart-key"))),
  }),
});

export type AppRouter = typeof appRouter;
