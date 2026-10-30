import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsString, Length, Matches, MaxLength } from 'class-validator';
import { BusinessType } from '../merchant-application.entity';

// Positive decimal with at most 2 fraction digits (matches numeric(_, 2)); rejects "-5", "1e3", "0".
const money = (maxIntDigits: number) => new RegExp(`^(?!0+(\\.0+)?$)\\d{1,${maxIntDigits}}(\\.\\d{1,2})?$`);

export class CreateApplicationDto {
  @ApiProperty({ example: 'Acme Coffee' })
  @IsString() @Length(2, 150)
  businessName: string;

  @ApiProperty({ example: 'Acme Coffee Roasters LLC' })
  @IsString() @Length(2, 200)
  legalBusinessName: string;

  @ApiProperty({ enum: BusinessType })
  @IsEnum(BusinessType)
  businessType: BusinessType;

  @ApiProperty({ example: 'Jane Doe', description: 'PII - encrypted at rest' })
  @IsString() @Length(2, 150)
  ownerName: string;

  @ApiProperty({ example: 'owner@example.test', description: 'PII - encrypted at rest' })
  @IsEmail() @MaxLength(254)
  contactEmail: string;

  @ApiProperty({ example: '25000.00', description: 'Decimal string, > 0, max 2 fraction digits' })
  @Matches(money(12), { message: 'requestedMonthlyVolume must be a positive amount with at most 2 decimals' })
  requestedMonthlyVolume: string;

  @ApiProperty({ example: '45.00', description: 'Decimal string, > 0, max 2 fraction digits' })
  @Matches(money(10), { message: 'requestedAverageTransaction must be a positive amount with at most 2 decimals' })
  requestedAverageTransaction: string;
}
