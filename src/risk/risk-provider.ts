import { Injectable } from '@nestjs/common';

export const RISK_PROVIDER = Symbol('RISK_PROVIDER');

/** Data minimisation: the provider sees business facts only, never owner identity or contact data. */
export interface RiskCheckInput {
  applicationId: string;
  businessName: string;
  legalBusinessName: string;
  businessType: string;
  requestedMonthlyVolume: string;
  requestedAverageTransaction: string;
}

export interface RiskAssessment {
  provider: string;
  outcome: 'CLEAR' | 'FLAGGED';
  score: number;
  reasons: string[];
  checkedAt: string;
}

export interface RiskProvider {
  assess(input: RiskCheckInput): Promise<RiskAssessment>;
}

/** Thrown for failures worth retrying (timeouts, 5xx from the provider). */
export class TransientProviderError extends Error {
  constructor(message = 'Risk provider temporarily unavailable') {
    super(message);
    this.name = 'TransientProviderError';
  }
}

/**
 * Deterministic stand-in for a third-party KYB provider. It never makes a network call.
 * Behaviour is driven by the input so local runs and tests are reproducible:
 *  - business name containing "[timeout]"  -> transient error on every attempt (exercises retries / FAILED)
 *  - legal name containing "sanction"      -> FLAGGED (watchlist hit)
 *  - monthly volume > 500,000              -> FLAGGED (high volume)
 *  - average transaction > 10,000          -> FLAGGED (high ticket)
 *  - anything else                         -> CLEAR
 */
@Injectable()
export class SimulatedKybProvider implements RiskProvider {
  static readonly NAME = 'SIMULATED_KYB';

  async assess(input: RiskCheckInput): Promise<RiskAssessment> {
    if (/\[timeout\]/i.test(input.businessName)) {
      throw new TransientProviderError();
    }

    const reasons: string[] = [];
    if (/sanction/i.test(input.legalBusinessName)) reasons.push('WATCHLIST_MATCH');
    if (Number(input.requestedMonthlyVolume) > 500_000) reasons.push('HIGH_VOLUME');
    if (Number(input.requestedAverageTransaction) > 10_000) reasons.push('HIGH_TICKET');

    return {
      provider: SimulatedKybProvider.NAME,
      outcome: reasons.length ? 'FLAGGED' : 'CLEAR',
      score: Math.min(100, reasons.length * 40),
      reasons,
      checkedAt: new Date().toISOString(),
    };
  }
}
