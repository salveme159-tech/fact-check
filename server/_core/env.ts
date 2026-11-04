// 서버 환경변수. 사용자가 화면에서 입력한 OpenDART 키를 우선 사용하므로 서버 키는 선택 사항입니다.
export const ENV = {
  get isProduction() { return process.env.NODE_ENV === "production"; },
  get opendartApiKey() { return process.env.OPENDART_API_KEY ?? ""; },
};
