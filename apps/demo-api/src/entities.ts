import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('customers')
export class Customer {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
  @Column({ unique: true }) email!: string;
}
@Entity('products')
export class Product {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
  @Column({ name: 'price_cents', type: 'integer' }) priceCents!: number;
}
@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ name: 'customer_id', type: 'integer' }) customerId!: number;
  @Column() status!: string;
  @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}
@Entity('order_items')
export class OrderItem {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ name: 'order_id', type: 'integer' }) orderId!: number;
  @Column({ name: 'product_id', type: 'integer' }) productId!: number;
  @Column({ type: 'integer' }) quantity!: number;
  @Column({ name: 'unit_price_cents', type: 'integer' }) unitPriceCents!: number;
}
