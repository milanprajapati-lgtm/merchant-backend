import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/**
 * `PartialType` makes every DTO field `@IsOptional()`, and class-validator treats `null` as "absent",
 * so `{"businessName": null}` would pass validation and then violate a NOT NULL column (a 500).
 * Partial-update bodies may omit a field but never null it.
 */
@Injectable()
export class RejectNullFieldsPipe implements PipeTransform {
  transform(value: unknown) {
    if (value && typeof value === 'object') {
      const nulled = Object.entries(value).filter(([, v]) => v === null).map(([k]) => k);
      if (nulled.length) throw new BadRequestException(`${nulled.join(', ')} must not be null; omit the field instead`);
    }
    return value;
  }
}
