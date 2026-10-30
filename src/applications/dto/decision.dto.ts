import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApplicationStatus } from '../merchant-application.entity';

export const DECISION_VALUES = [
  ApplicationStatus.APPROVED,
  ApplicationStatus.REJECTED,
  ApplicationStatus.NEEDS_INFORMATION,
] as const;

export class DecisionDto {
  @ApiProperty({ enum: DECISION_VALUES })
  @IsIn(DECISION_VALUES)
  decision: (typeof DECISION_VALUES)[number];

  @ApiPropertyOptional({ maxLength: 500, description: 'Reviewer note. Do not put personal data or secrets here.' })
  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}
