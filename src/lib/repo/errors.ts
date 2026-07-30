/**
 * 참조 데이터 조회 실패를 두 갈래로 구분한다.
 *
 * 하나로 뭉치면 **전체 장애가 "사용자 입력 문제"로 나가거나 그 반대**가 된다.
 * 원장이 통째로 비어 duty 가 전부 0 이 되는 사고를 "기준일을 확인하세요" 로
 * 안내하면 아무도 고치지 못한다.
 *
 *   config    참조 테이블이 비어 있다 → 배포·설정 실패. 운영자가 고쳐야 한다
 *   coverage  행은 있으나 그 기준일을 덮는 게 없다 → 사용자 입력 문제.
 *             예: 2020년으로 조회했는데 원장이 2024년부터 시작한다
 */
export type ReferenceDataErrorKind = 'config' | 'coverage'

/**
 * ── 새 참조 테이블이 생겼을 때: 0행을 실패로 볼 것인가 ──────────────
 *
 * 판정 기준은 "0행이 정상인가" 가 아니다. **0행이 숫자를 어느 방향으로 미는가** 다.
 *
 *   0행이 관세를 **낮추면**(과소계상)  → 명시적 실패
 *   0행이 관세를 **높이거나 중립이면** → 정상 상태로 취급
 *
 * 지금까지의 적용:
 *   rate_ledger        비면 duty 0 → 과소계상 → 실패
 *   duty_programs      비면 적용 프로그램 없음 → 과소계상 → 실패
 *   fee_settings       비면 MPF/HMF 누락 → 과소계상 → 실패
 *   program_exclusions 비면 전액 부과 → 안전한 방향 → 정상 (현재 실제로 0행)
 *
 * 미검증 면제를 적용하지 않기로 한 것(exclusionStatus 의 unverified)과 같은
 * 원칙이다 — 과대계상은 고객이 예산을 넉넉히 잡을 뿐이지만, 과소계상은 가격을
 * 잘못 매겨 마진을 잃는다. 이 제품이 없애준다고 약속한 바로 그 손해다.
 */

export class ReferenceDataError extends Error {
  readonly kind: ReferenceDataErrorKind
  readonly table: string

  constructor(kind: ReferenceDataErrorKind, table: string, message: string) {
    super(message)
    this.name = 'ReferenceDataError'
    this.kind = kind
    this.table = table
  }

  /** 참조 테이블이 비어 있다 — 배포·설정 실패 */
  static config(table: string): ReferenceDataError {
    return new ReferenceDataError(
      'config',
      table,
      `Rate data is not available right now (${table} is empty). ` +
        `This is a configuration problem on our side, not something you did — ` +
        `please contact support@landediq.app.`,
    )
  }

  /** 기준일을 덮는 행이 없다 — 사용자 입력 문제 */
  static coverage(table: string, asOf: string): ReferenceDataError {
    return new ReferenceDataError(
      'coverage',
      table,
      `No rate data covers ${asOf}. Pick a date within the period we have rates for, ` +
        `then run the report again.`,
    )
  }
}
