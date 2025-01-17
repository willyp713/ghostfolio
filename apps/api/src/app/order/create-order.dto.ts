import { AssetClass, AssetSubClass, DataSource, Type } from '@prisma/client';
import {
  IsEnum,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString
} from 'class-validator';

export class CreateOrderDto {
  @IsString()
  @IsOptional()
  accountId?: string;

  @IsEnum(AssetClass, { each: true })
  @IsOptional()
  assetClass?: AssetClass;

  @IsEnum(AssetSubClass, { each: true })
  @IsOptional()
  assetSubClass?: AssetSubClass;

  @IsString()
  currency: string;

  @IsEnum(DataSource, { each: true })
  @IsOptional()
  dataSource?: DataSource;

  @IsISO8601()
  date: string;

  @IsNumber()
  fee: number;

  @IsNumber()
  quantity: number;

  @IsString()
  symbol: string;

  @IsEnum(Type, { each: true })
  type: Type;

  @IsNumber()
  unitPrice: number;
}
