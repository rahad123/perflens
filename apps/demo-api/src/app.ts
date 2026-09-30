import { BadRequestException, Body, Controller, Get, Injectable, Module, NotFoundException, Param, ParseIntPipe, Post, Query, Res, ServiceUnavailableException } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { Response } from 'express';
import { get } from 'node:http';
import { Customer, Order, OrderItem, Product } from './entities';
import { InitialSchema1780000000000 } from './migration';
import { registry } from './metrics';

class ItemInput {
  @IsInt() @Min(1) productId!: number;
  @IsInt() @Min(1) @Max(100) quantity!: number;
}
class CreateOrder {
  @IsInt() @Min(1) customerId!: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50)
  @ValidateNested({ each: true }) @Type(() => ItemInput) items!: ItemInput[];
}
class Pagination {
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
  @Type(() => Number) @IsInt() @Min(0) @Max(1000000) offset = 0;
}

@Injectable()
class OrdersService {
  constructor(private readonly db: DataSource) {}
  list(page: Pagination) {
    return this.db.getRepository(Order).find({ order: { id: 'DESC' }, take: page.limit, skip: page.offset });
  }
  async detail(id: number) {
    const order = await this.db.getRepository(Order).findOneBy({ id });
    if (!order) throw new NotFoundException('Order not found');
    const [customer, items] = await Promise.all([
      this.db.getRepository(Customer).findOneByOrFail({ id: order.customerId }),
      this.db.query('SELECT i.*, p.name AS product_name FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = $1 ORDER BY i.id', [id]),
    ]);
    return { ...order, customer, items };
  }
  async create(input: CreateOrder) {
    return this.db.transaction(async (manager) => {
      if (!await manager.existsBy(Customer, { id: input.customerId })) throw new BadRequestException('Unknown customer');
      const products = await manager.findBy(Product, { id: In(input.items.map((item) => item.productId)) });
      const prices = new Map(products.map((p) => [p.id, p.priceCents]));
      if (input.items.some((item) => !prices.has(item.productId))) throw new BadRequestException('Unknown product');
      const order = await manager.save(Order, { customerId: input.customerId, status: 'pending', createdAt: new Date() });
      const items = await manager.save(OrderItem, input.items.map((item) => ({ ...item, orderId: order.id, unitPriceCents: prices.get(item.productId)! })));
      return { ...order, items };
    });
  }
}

@Controller()
class ApiController {
  constructor(private readonly db: DataSource, private readonly orders: OrdersService) {}
  @Get() index() {
    return {
      service: 'PerfLens Demo API',
      endpoints: [
        'GET /health', 'GET /orders', 'GET /orders/:id', 'POST /orders',
        'GET /performance/slow-query', 'GET /performance/external-call',
        'GET /performance/n-plus-one', 'GET /metrics',
      ],
    };
  }
  @Get('health') async health() {
    try { await this.db.query('SELECT 1'); return { status: 'ok', database: 'up' }; }
    catch { throw new ServiceUnavailableException('Database unavailable'); }
  }
  @Get('metrics') async metrics(@Res() res: Response) {
    res.type(registry.contentType).send(await registry.metrics());
  }
  @Get('orders') list(@Query() page: Pagination) { return this.orders.list(page); }
  @Get('orders/:id') detail(@Param('id', ParseIntPipe) id: number) { return this.orders.detail(id); }
  @Post('orders') create(@Body() body: CreateOrder) { return this.orders.create(body); }
}

@Controller('performance')
class PerformanceController {
  constructor(private readonly db: DataSource) {}
  @Get('slow-query') async slowQuery() {
    // INTENTIONAL DEMO: expression prevents use of the order_id index in a
    // correlated aggregate, scanning all items repeatedly. Bounded at 100 orders.
    return this.db.query(`SELECT o.id, (SELECT sum(i.quantity * i.unit_price_cents)
      FROM order_items i WHERE i.order_id::text = o.id::text) AS total_cents
      FROM orders o WHERE o.id <= 100 ORDER BY total_cents DESC`);
  }
  @Get('n-plus-one') async nPlusOne() {
    // INTENTIONAL DEMO: one list query followed by 20 sequential item queries.
    const orders = await this.db.getRepository(Order).find({ take: 20, order: { id: 'DESC' } });
    const result = [];
    for (const order of orders) {
      const items = await this.db.getRepository(OrderItem).findBy({ orderId: order.id });
      result.push({ ...order, items });
    }
    return result;
  }
  @Get('external-call') async externalCall() {
    // INTENTIONAL DEMO: real HTTP call to a loopback-only latency simulator.
    return new Promise((resolve, reject) => {
      const request = get('http://127.0.0.1:4001/dependency', (response) => {
        response.resume();
        response.on('end', () => response.statusCode === 200
          ? resolve({ dependency: 'simulated-shipping-provider', status: 'ok' })
          : reject(new ServiceUnavailableException('Simulated dependency failed')));
        response.on('error', () => reject(new ServiceUnavailableException('Simulated dependency failed')));
      });
      request.setTimeout(5000, () => request.destroy(new Error('Dependency timeout')));
      request.on('error', () => reject(new ServiceUnavailableException('Simulated dependency unavailable')));
    });
  }
}

@Module({
  imports: [TypeOrmModule.forRoot({
    type: 'postgres', host: process.env.POSTGRES_HOST ?? 'postgres', port: 5432,
    username: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB, entities: [Customer, Order, OrderItem, Product],
    migrations: [InitialSchema1780000000000], migrationsRun: true, synchronize: false,
    extra: { max: 10, statement_timeout: 15000, connectionTimeoutMillis: 5000 },
  })],
  controllers: [ApiController, PerformanceController], providers: [OrdersService],
})
export class AppModule {}
